const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createTailnetChangeStore,
} = require("../../lib/server/tailscale/change-store");
const {
  createTailnetChangeService,
  getDnsSuffixFromDevice,
  hasHostnameCollision,
  resolveTailnetDnsSuffix,
} = require("../../lib/server/tailscale/change-service");

const jsonResponse = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (key) => headers[String(key).toLowerCase()] || "" },
  text: async () => JSON.stringify(data),
});

const createApiFetch = ({ devices = [] } = {}) =>
  vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    if (url.endsWith("/acl") && method === "GET") {
      return jsonResponse({ grants: [], ssh: [] }, { headers: { etag: "v1" } });
    }
    if (url.endsWith("/acl/validate") && method === "POST") {
      return jsonResponse({});
    }
    if (url.endsWith("/acl") && method === "POST") return jsonResponse({});
    if (url.endsWith("/settings") && method === "GET") {
      return jsonResponse({ httpsEnabled: false });
    }
    if (url.endsWith("/settings") && method === "PATCH") {
      return jsonResponse({ httpsEnabled: true });
    }
    if (url.endsWith("/dns/preferences")) {
      return jsonResponse({ magicDNS: true });
    }
    if (url.endsWith("/devices")) return jsonResponse({ devices });
    if (url.endsWith("/keys") && method === "POST") {
      return jsonResponse({ key: "tskey-auth-one-time-secret" });
    }
    return jsonResponse({ message: `Unhandled ${method} ${url}` }, { status: 500 });
  });

const createHarness = ({ devices = [] } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-change-"));
  const statePath = path.join(rootDir, "tailnet-change.json");
  const changeStore = createTailnetChangeStore({ fs, statePath });
  const staged = [];
  const hostManager = {
    check: vi.fn(async () => ({ ok: true, available: true })),
    getStatus: vi.fn(async () => ({ state: "queued" })),
    stageAndSchedule: vi.fn(async (request) => {
      staged.push(request);
      return { ok: true, state: "queued" };
    }),
  };
  const readEnvFile = vi.fn(() => [
    { key: "ALPHACLAW_SETUP_URL", value: "https://alphaclaw.old.ts.net" },
    {
      key: "ALPHACLAW_PUBLIC_BASE_URL",
      value: "https://alphaclaw.old.ts.net:8443",
    },
  ]);
  const shellCmd = vi.fn(async (command) => {
    if (command === "tailscale status --json") {
      return JSON.stringify({ Self: { DNSName: "alphaclaw.old.ts.net." } });
    }
    throw new Error(`Unexpected shell command: ${command}`);
  });
  const writeEnvFile = vi.fn();
  const ensureGatewayProxyConfig = vi.fn(() => false);
  const restartGateway = vi.fn();
  const service = createTailnetChangeService({
    fs,
    constants: {
      kOnboardingMarkerPath: path.join(rootDir, "onboarded.json"),
      WORKSPACE_DIR: path.join(rootDir, "workspace"),
    },
    shellCmd,
    readEnvFile,
    writeEnvFile,
    reloadEnv: vi.fn(),
    hostManager,
    changeStore,
    ensureGatewayProxyConfig,
    restartGateway,
    fetchImpl: createApiFetch({ devices }),
    defer: vi.fn(),
  });
  return {
    rootDir,
    statePath,
    changeStore,
    hostManager,
    staged,
    service,
    writeEnvFile,
    ensureGatewayProxyConfig,
    restartGateway,
  };
};

describe("server/tailscale/change-service", () => {
  it("derives tailnet DNS suffixes and detects hostname collisions", () => {
    const device = {
      hostname: "laptop",
      name: "laptop.new-tailnet.ts.net.",
    };
    expect(getDnsSuffixFromDevice(device)).toBe("new-tailnet.ts.net");
    expect(resolveTailnetDnsSuffix([{}, device])).toBe("new-tailnet.ts.net");
    expect(hasHostnameCollision([{ hostname: "AlphaClaw" }], "alphaclaw")).toBe(
      true,
    );
  });

  it("validates a new empty tailnet using only its API token", async () => {
    const { service } = createHarness();

    await expect(
      service.validateTarget({
        tailscaleApiToken: "tskey-api-new-account-secret",
      }),
    ).resolves.toMatchObject({
      ok: true,
      currentDns: "alphaclaw.old.ts.net",
    });
  });

  it("rejects the current tailnet when its suffix can be inferred", async () => {
    const { service } = createHarness({
      devices: [{ hostname: "laptop", name: "laptop.old.ts.net" }],
    });

    await expect(
      service.validateTarget({
        tailscaleApiToken: "tskey-api-current-account-secret",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("schedules the host switch without persisting either secret", async () => {
    const { service, statePath, staged } = createHarness();
    const apiToken = "tskey-api-new-account-secret";

    const result = await service.startChange({
      tailscaleApiToken: apiToken,
      expectedCurrentDns: "alphaclaw.old.ts.net",
    });

    expect(result).toMatchObject({
      ok: true,
      state: "queued",
    });
    expect(staged[0]).toMatchObject({
      hostname: "alphaclaw",
      previousDnsName: "alphaclaw.old.ts.net",
      authKey: "tskey-auth-one-time-secret",
    });
    expect(staged[0]).not.toHaveProperty("expectedDnsSuffix");
    const durableState = fs.readFileSync(statePath, "utf8");
    expect(durableState).not.toContain(apiToken);
    expect(durableState).not.toContain("tskey-auth-one-time-secret");
  });

  it("rejects a concurrent start before either request can schedule twice", async () => {
    const { service, hostManager } = createHarness();
    const input = {
      tailscaleApiToken: "tskey-api-new-account-secret",
      expectedCurrentDns: "alphaclaw.old.ts.net",
    };

    const first = service.startChange(input);
    await expect(service.startChange(input)).rejects.toMatchObject({
      status: 409,
    });
    await expect(first).resolves.toMatchObject({ state: "queued" });
    expect(hostManager.stageAndSchedule).toHaveBeenCalledTimes(1);
  });

  it("finalizes URLs from the DNS name reported after the switch", async () => {
    const {
      service,
      changeStore,
      hostManager,
      writeEnvFile,
      ensureGatewayProxyConfig,
      restartGateway,
    } = createHarness();
    changeStore.write({
      operationId: "op-finalize",
      state: "switching",
      currentDns: "alphaclaw.old.ts.net",
    });
    hostManager.getStatus.mockResolvedValue({
      operationId: "op-finalize",
      state: "completed",
      dnsName: "alphaclaw.new-tailnet.ts.net",
    });
    ensureGatewayProxyConfig.mockReturnValue(true);

    const result = await service.reconcileHostStatus();

    expect(result).toMatchObject({
      state: "completed_with_warnings",
      dnsName: "alphaclaw.new-tailnet.ts.net",
      setupUrl: "https://alphaclaw.new-tailnet.ts.net",
      publicBaseUrl: "https://alphaclaw.new-tailnet.ts.net:8443",
    });
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.new-tailnet.ts.net",
        },
      ]),
    );
    expect(ensureGatewayProxyConfig).toHaveBeenCalledWith(
      "https://alphaclaw.new-tailnet.ts.net",
    );
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });
});
