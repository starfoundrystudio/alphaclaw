const {
  ensureAlphaClawTailscalePolicy,
  getTailscaleApiTokenValidation,
  createTailscaleFinalizer,
} = require("../../lib/server/onboarding/tailscale-finalizer");

describe("server/onboarding/tailscale-finalizer", () => {
  it("validates Tailscale API access token shape", () => {
    expect(getTailscaleApiTokenValidation("").ok).toBe(false);
    expect(getTailscaleApiTokenValidation("tskey-auth-abc").ok).toBe(false);
    expect(getTailscaleApiTokenValidation("tskey-api-abc").ok).toBe(true);
  });

  it("merges AlphaClaw rules into grants policy without replacing custom policy", () => {
    const input = {
      groups: { "group:dev": ["dev@example.com"] },
      tagOwners: { "tag:db": ["autogroup:admin"] },
      grants: [
        {
          src: ["group:dev"],
          dst: ["tag:db"],
          ip: ["tcp:5432"],
        },
      ],
      ssh: [],
    };

    const result = ensureAlphaClawTailscalePolicy(input);

    expect(result.changed).toBe(true);
    expect(result.policy.groups).toEqual(input.groups);
    expect(result.policy.tagOwners["tag:openclaw"]).toContain("autogroup:admin");
    expect(result.policy.nodeAttrs).toEqual([
      { target: ["tag:openclaw"], attr: ["funnel"] },
    ]);
    expect(result.policy.grants).toEqual([
      input.grants[0],
      {
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        ip: ["tcp:443", "tcp:8443", "tcp:22"],
      },
    ]);
    expect(result.policy.ssh).toEqual([
      {
        action: "accept",
        src: ["cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        users: ["root", "alphaclaw"],
      },
    ]);
  });

  it("adds a distinct cloud-ops SSH rule without editing existing SSH rules", () => {
    const defaultSshRule = {
      src: ["autogroup:member"],
      dst: ["autogroup:self"],
      users: ["autogroup:nonroot", "root"],
      action: "check",
    };
    const partialCloudOpsRule = {
      src: ["cloud-ops@teamyou.ai"],
      dst: ["tag:openclaw"],
      users: ["root"],
      action: "accept",
    };

    const result = ensureAlphaClawTailscalePolicy({
      acls: [],
      ssh: [defaultSshRule, partialCloudOpsRule],
    });

    expect(result.policy.ssh).toEqual([
      defaultSshRule,
      partialCloudOpsRule,
      {
        src: ["cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        users: ["root", "alphaclaw"],
        action: "accept",
      },
    ]);
  });

  it("uses ACLs when the policy does not use grants", () => {
    const result = ensureAlphaClawTailscalePolicy({ acls: [] });

    expect(result.policy.grants).toBeUndefined();
    expect(result.policy.acls).toEqual([
      {
        action: "accept",
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw:443", "tag:openclaw:8443", "tag:openclaw:22"],
      },
    ]);
  });

  it("runs policy, CLI, env, share, and TeamYou finalization in order", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      calls.push(["fetch", url, opts.method || "GET"]);
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => '"etag-1"' },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      calls.push(["shell", cmd]);
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const readEnvFile = vi.fn(() => [{ key: "OPENAI_API_KEY", value: "sk-test" }]);
    const writeEnvFile = vi.fn((vars) => calls.push(["writeEnv", vars]));
    const reloadEnv = vi.fn(() => calls.push(["reloadEnv"]));
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile,
      writeEnvFile,
      reloadEnv,
      fetchImpl,
      env: {
        TEAMYOU_FINALIZE_CALLBACK_URL: "https://teamyou.example/finalize",
        TEAMYOU_FINALIZE_CALLBACK_TOKEN: "callback-secret",
      },
    });

    const result = await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });
    const expectedTailscaleAuth = `Basic ${Buffer.from("tskey-api-secret:").toString("base64")}`;

    expect(result).toMatchObject({
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      deviceId: "device-123",
    });
    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale up --auth-key='tskey-auth-secret' --hostname='alphaclaw' --ssh",
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([
        { key: "ALPHACLAW_SETUP_URL", value: "https://alphaclaw.tail123.ts.net" },
        {
          key: "ALPHACLAW_PUBLIC_BASE_URL",
          value: "https://alphaclaw.tail123.ts.net:8443",
        },
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://teamyou.example/finalize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer callback-secret",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tailscale.com/api/v2/tailnet/-/acl",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expectedTailscaleAuth,
        }),
      }),
    );
    expect(calls.map((entry) => entry[0])).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "fetch",
      "shell",
      "shell",
      "shell",
      "fetch",
      "writeEnv",
      "reloadEnv",
      "fetch",
    ]);
  });

  it("surfaces an actionable error when the host exposure wrapper is missing", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      if (cmd === "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all") {
        const error = new Error("Command failed");
        error.stderr = "sudo: /usr/local/sbin/alphaclaw-tailscale-expose: command not found";
        throw error;
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {},
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow(/older clawctl/);
    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale up --auth-key='tskey-auth-secret' --hostname='alphaclaw' --ssh",
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
  });

  it("reuses an already-joined host on retry after local URLs were written", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              tagOwners: { "tag:openclaw": ["autogroup:admin"] },
              nodeAttrs: [{ target: ["tag:openclaw"], attr: ["funnel"] }],
              grants: [
                {
                  src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
                  dst: ["tag:openclaw"],
                  ip: ["tcp:443", "tcp:8443", "tcp:22"],
                },
              ],
              ssh: [
                {
                  action: "accept",
                  src: ["cloud-ops@teamyou.ai"],
                  dst: ["tag:openclaw"],
                  users: ["root", "alphaclaw"],
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile: vi.fn(() => [
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {},
    });

    await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/keys"))).toBe(false);
  });
});
