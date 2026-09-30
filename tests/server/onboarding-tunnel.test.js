const express = require("express");
const request = require("supertest");

const { registerOnboardingRoutes } = require("../../lib/server/routes/onboarding");
const { createOperationEventsService } = require("../../lib/server/operation-events");
const {
  buildTunnelNetworkFinalizedPayload,
} = require("../../lib/server/onboarding/tailscale-finalizer");

const kMarkerPath = "/tmp/alphaclaw-tunnel/onboarded.json";
const kSetupUrl = "https://abc123def456.teamyou.io";
const kHooksUrl = "https://abc123def456-hooks.teamyou.io";
const kVaultUrl = "https://abc123def456-vault.teamyou.io";
const kWebhookUrl = "https://www.teamyou.com/api/openclaw/instances/webhook";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createTunnelEnv = (overrides = {}) => ({
  ALPHACLAW_INGRESS_MODE: "cloudflare_tunnel",
  ALPHACLAW_CONNECTIVITY_MODE: "security_gateway",
  ALPHACLAW_SETUP_URL: kSetupUrl,
  ALPHACLAW_PUBLIC_BASE_URL: kHooksUrl,
  AGENT_VAULT_OPERATOR_URL: kVaultUrl,
  OPENCLAW_WEBHOOK_URL: kWebhookUrl,
  OPENCLAW_WEBHOOK_TOKEN: "whk_test_token",
  OPENCLAW_INSTANCE_ID: "inst_abc123",
  ...overrides,
});

const createDeps = ({ env = createTunnelEnv() } = {}) => {
  const files = new Map();
  const order = [];
  const fetchImpl = vi.fn(async () => {
    order.push("webhook");
    return { ok: true, status: 200 };
  });
  global.fetch = fetchImpl;
  return {
    order,
    fetchImpl,
    env,
    fs: {
      mkdirSync: vi.fn(),
      existsSync: vi.fn((target) => files.has(target)),
      readFileSync: vi.fn((target) => (files.has(target) ? files.get(target) : "{}")),
      writeFileSync: vi.fn((target, content) => {
        if (target === kMarkerPath) order.push("marker");
        files.set(target, String(content));
      }),
      statSync: vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      readdirSync: vi.fn(() => []),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
      appendFileSync: vi.fn(),
    },
    constants: {
      kRootDir: "/tmp/alphaclaw-tunnel",
      OPENCLAW_DIR: "/tmp/alphaclaw-tunnel/.openclaw",
      WORKSPACE_DIR: "/tmp/alphaclaw-tunnel/.openclaw/workspace",
      kOnboardingMarkerPath: kMarkerPath,
    },
    shellCmd: vi.fn(async () => ""),
    gatewayEnv: vi.fn(() => ({})),
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    isOnboarded: vi.fn(() => false),
    resolveModelProvider: vi.fn((modelKey) => String(modelKey).split("/")[0]),
    hasCodexOauthProfile: vi.fn(() => false),
    hasClaudeCliProfile: vi.fn(() => false),
    authProfiles: {
      getEnvVarForApiKeyProvider: vi.fn(() => ""),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      syncConfigAuthReferencesForAgent: vi.fn(),
    },
    ensureGatewayProxyConfig: vi.fn(),
    getBaseUrl: vi.fn(() => kSetupUrl),
    reconcileOpenclawPlugins: vi.fn(),
    tailscaleFinalizer: {
      finalizeTailscaleOnboarding: vi.fn(async () => {
        throw new Error("Tailscale finalizer must not run in tunnel mode");
      }),
    },
    prepareAgentVaultRuntime: vi.fn(async () => {
      order.push("vault");
      return { ready: true };
    }),
    runOnboardedBootSequence: vi.fn(),
    operationEvents: createOperationEventsService(),
    hostFinalizationDelayMs: 0,
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  const { order, fetchImpl, ...routeDeps } = deps;
  registerOnboardingRoutes({ app, ...routeDeps });
  return app;
};

const kValidBody = {
  modelKey: "openai/gpt-5.1-codex",
  vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
};

const runToCompletion = async (app, deps, body = kValidBody) => {
  const res = await request(app).post("/api/onboard").send(body);
  expect(res.status).toBe(202);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const operation = deps.operationEvents.getOperation(res.body.operationId);
    if (operation.status !== "pending") {
      await tick();
      await tick();
      return operation;
    }
    await tick();
  }
  throw new Error("operation did not settle");
};

describe("Cloudflare Tunnel onboarding", () => {
  it("reports the ingress mode on the status endpoint", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps)).get("/api/onboard/status");
    expect(res.body.ingressMode).toBe("cloudflare_tunnel");
    expect(res.body.onboarded).toBe(false);
  });

  it("completes without a Tailscale token or any Tailscale step", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const operation = await runToCompletion(app, deps);

    expect(operation.status).toBe("completed");
    expect(operation.events.at(-1)).toMatchObject({
      event: "done",
      data: {
        ok: true,
        setupUrl: kSetupUrl,
        publicBaseUrl: kHooksUrl,
        ingressMode: "cloudflare_tunnel",
      },
    });
    expect(operation.events.at(-1).data.tailscaleDns).toBeUndefined();
    expect(operation.events.at(-1).data.handoffViaBootstrapOrigin).toBeUndefined();
    expect(deps.tailscaleFinalizer.finalizeTailscaleOnboarding).not.toHaveBeenCalled();
    // No env rewrite of the fixed URLs: only the onboarding var write.
    for (const [items] of deps.writeEnvFile.mock.calls) {
      expect(items.map((entry) => entry.key)).not.toContain(
        "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
      );
    }
    const phases = operation.events
      .filter((entry) => entry.event === "phase")
      .map((entry) => entry.data.phase);
    expect(phases).toEqual([
      "validating",
      "configuring",
      "plugins",
      "vault",
      "network",
      "finishing",
    ]);
  });

  it("prepares Agent Vault, then sends the C5 webhook, then writes the marker", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    await runToCompletion(app, deps);

    expect(deps.order).toEqual(["vault", "webhook", "marker"]);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(url).toBe(kWebhookUrl);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer whk_test_token");
    expect(JSON.parse(init.body)).toEqual({
      type: "instance.network_finalized",
      instance_id: "inst_abc123",
      ingress_mode: "cloudflare_tunnel",
      setup_url: kSetupUrl,
      public_base_url: kHooksUrl,
      agent_vault_operator_url: kVaultUrl,
    });

    const marker = JSON.parse(deps.fs.readFileSync(kMarkerPath));
    expect(marker).toMatchObject({
      onboarded: true,
      reason: "onboarding_complete",
      setupUrl: kSetupUrl,
      publicBaseUrl: kHooksUrl,
      hostFinalizationScheduled: true,
      initialRuntimeCheckRequired: true,
    });
    expect(marker).not.toHaveProperty("tailscaleDns");
    expect(marker).not.toHaveProperty("handoffViaBootstrapOrigin");
    expect(deps.ensureGatewayProxyConfig).toHaveBeenCalledWith(kSetupUrl);
  });

  it("builds the tunnel payload with clawbridge_sso only when true", () => {
    const base = {
      setupUrl: kSetupUrl,
      publicBaseUrl: kHooksUrl,
      agentVaultOperatorUrl: kVaultUrl,
    };
    expect(
      buildTunnelNetworkFinalizedPayload({
        ...base,
        writebackConfig: { instanceId: "inst_x", clawbridgeSso: true },
      }),
    ).toEqual({
      type: "instance.network_finalized",
      instance_id: "inst_x",
      ingress_mode: "cloudflare_tunnel",
      setup_url: kSetupUrl,
      public_base_url: kHooksUrl,
      agent_vault_operator_url: kVaultUrl,
      clawbridge_sso: true,
    });
    expect(
      Object.keys(
        buildTunnelNetworkFinalizedPayload({
          ...base,
          writebackConfig: { instanceId: "inst_x", clawbridgeSso: false },
        }),
      ),
    ).not.toContain("clawbridge_sso");
  });

  it("rejects a Tailscale token synchronously", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps))
      .post("/api/onboard")
      .send({ ...kValidBody, tailscaleApiToken: "tskey-api-test_123456789" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not use Tailscale");
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it.each([
    ["missing setup URL", { ALPHACLAW_SETUP_URL: "" }, "ALPHACLAW_SETUP_URL"],
    ["setup URL with a path", { ALPHACLAW_SETUP_URL: `${kSetupUrl}/setup` }, "ALPHACLAW_SETUP_URL"],
    ["http hooks URL", { ALPHACLAW_PUBLIC_BASE_URL: "http://abc-hooks.teamyou.io" }, "ALPHACLAW_PUBLIC_BASE_URL"],
    ["vault URL with a port", { AGENT_VAULT_OPERATOR_URL: `${kVaultUrl}:8443` }, "AGENT_VAULT_OPERATOR_URL"],
  ])("refuses to start with a %s", async (_label, overrides, envKey) => {
    const deps = createDeps({ env: createTunnelEnv(overrides) });
    const res = await request(createApp(deps)).post("/api/onboard").send(kValidBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain(envKey);
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("requires the TeamYou writeback and the security gateway mode", async () => {
    const noWebhook = createDeps({ env: createTunnelEnv({ OPENCLAW_WEBHOOK_URL: "" }) });
    const first = await request(createApp(noWebhook)).post("/api/onboard").send(kValidBody);
    expect(first.status).toBe(500);
    expect(first.body.error).toContain("TeamYou writeback is required");

    const local = createDeps({ env: createTunnelEnv({ ALPHACLAW_CONNECTIVITY_MODE: "local" }) });
    const second = await request(createApp(local)).post("/api/onboard").send(kValidBody);
    expect(second.status).toBe(500);
    expect(second.body.error).toContain("security gateway");
  });

  it("does not mark onboarding complete when the webhook fails", async () => {
    const deps = createDeps();
    deps.fetchImpl.mockImplementation(async () => ({ ok: false, status: 409 }));
    const app = createApp(deps);

    const operation = await runToCompletion(app, deps);

    expect(operation.status).toBe("failed");
    expect(operation.events.at(-1).data.error).toBe(
      "TeamYou writeback failed. Please retry setup.",
    );
    expect(deps.fs.existsSync(kMarkerPath)).toBe(false);
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("does not report to TeamYou when Agent Vault is not ready", async () => {
    const deps = createDeps();
    deps.prepareAgentVaultRuntime.mockResolvedValueOnce({
      ready: false,
      reason: "owner_pending",
    });
    const app = createApp(deps);

    const operation = await runToCompletion(app, deps);

    expect(operation.status).toBe("failed");
    expect(operation.events.at(-1).data.error).toBe(
      "Automatic Agent Vault initialization did not complete",
    );
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.fs.existsSync(kMarkerPath)).toBe(false);
  });
});
