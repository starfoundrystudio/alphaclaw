const express = require("express");
const request = require("supertest");

const { registerOnboardingRoutes } = require("../../lib/server/routes/onboarding");
const { createOperationEventsService } = require("../../lib/server/operation-events");
const {
  createOnboardingOperationRunner,
  kHostFinalizationDelayMs,
} = require("../../lib/server/onboarding/operation");

const kMarkerPath = "/tmp/alphaclaw-op/onboarded.json";
const kCheckCmd = "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup check";
const kCompleteCmd = "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup complete";

const createDeferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createDeps = () => {
  const files = new Map();
  return {
    fs: {
      mkdirSync: vi.fn(),
      existsSync: vi.fn((target) => files.has(target)),
      readFileSync: vi.fn((target) =>
        files.has(target) ? files.get(target) : "{}",
      ),
      writeFileSync: vi.fn((target, content) => {
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
      kRootDir: "/tmp/alphaclaw-op",
      OPENCLAW_DIR: "/tmp/alphaclaw-op/.openclaw",
      WORKSPACE_DIR: "/tmp/alphaclaw-op/.openclaw/workspace",
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
    getBaseUrl: vi.fn(() => "https://example.com"),
    reconcileOpenclawPlugins: vi.fn(),
    tailscaleFinalizer: {
      finalizeTailscaleOnboarding: vi.fn(async () => ({
        setupUrl: "https://alphaclaw.tail123.ts.net",
        publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
        dnsName: "alphaclaw.tail123.ts.net",
      })),
    },
    prepareAgentVaultRuntime: vi.fn(async () => ({ ready: true })),
    runOnboardedBootSequence: vi.fn(),
    operationEvents: createOperationEventsService(),
    hostFinalizationDelayMs: 0,
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerOnboardingRoutes({ app, ...deps });
  return app;
};

const kValidBody = {
  modelKey: "openai/gpt-5.1-codex",
  tailscaleApiToken: "tskey-api-test_123456789",
  vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
};

const waitForSettled = async (deps, operationId) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const operation = deps.operationEvents.getOperation(operationId);
    if (operation?.status !== "pending") return operation;
    await tick();
  }
  throw new Error("operation did not settle");
};

describe("asynchronous setup completion", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("returns 202 with an operation id before the setup work finishes", async () => {
    const deps = createDeps();
    const gate = createDeferred();
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd === kCheckCmd) await gate.promise;
      return "";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(kValidBody);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      operationId: expect.any(String),
      streamUrl: `/api/operations/${res.body.operationId}/events`,
    });
    expect(deps.operationEvents.getOperation(res.body.operationId).status).toBe(
      "pending",
    );
    gate.resolve();
    const operation = await waitForSettled(deps, res.body.operationId);
    expect(operation.status).toBe("completed");
  });

  it("returns the same operation to a second POST and exposes it for re-attach", async () => {
    const deps = createDeps();
    const gate = createDeferred();
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd === kCheckCmd) await gate.promise;
      return "";
    });
    const app = createApp(deps);

    const first = await request(app).post("/api/onboard").send(kValidBody);
    const second = await request(app).post("/api/onboard").send({});
    expect(second.status).toBe(202);
    expect(second.body.operationId).toBe(first.body.operationId);

    const during = await request(app).get("/api/onboard/status");
    expect(during.body.onboarded).toBe(false);
    expect(during.body.onboardingOperation).toEqual({
      operationId: first.body.operationId,
    });

    gate.resolve();
    await waitForSettled(deps, first.body.operationId);
    expect(
      deps.shellCmd.mock.calls.filter(([cmd]) => cmd === kCheckCmd),
    ).toHaveLength(1);

    const after = await request(app).get("/api/onboard/status");
    expect(after.body.onboarded).toBe(true);
    expect(after.body.onboardingOperation).toBeUndefined();

    const again = await request(app).post("/api/onboard").send(kValidBody);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: false, error: "Already onboarded" });
  });

  it("publishes coarse progress, then the success body as the final event", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(kValidBody);
    const operation = await waitForSettled(deps, res.body.operationId);

    const phases = operation.events
      .filter((entry) => entry.event === "phase")
      .map((entry) => entry.data.phase);
    expect(phases).toEqual([
      "validating",
      "configuring",
      "plugins",
      "network",
      "finishing",
    ]);
    for (const entry of operation.events.filter((e) => e.event === "phase")) {
      expect(entry.data.label).toEqual(expect.any(String));
      expect(entry.data.label.length).toBeGreaterThan(0);
    }
    const last = operation.events.at(-1);
    expect(last.event).toBe("done");
    expect(last.data).toEqual({
      ok: true,
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      tailscaleDns: "alphaclaw.tail123.ts.net",
    });
  });

  it("runs host finalization only after the final event is published", async () => {
    const deps = createDeps();
    const order = [];
    const complete = deps.operationEvents.complete;
    deps.operationEvents.complete = vi.fn((...args) => {
      order.push("done-event");
      return complete(...args);
    });
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd === kCompleteCmd) order.push("host-finalize");
      return "";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(kValidBody);
    await waitForSettled(deps, res.body.operationId);
    for (let attempt = 0; attempt < 50 && order.length < 2; attempt += 1) {
      await tick();
    }

    expect(order).toEqual(["done-event", "host-finalize"]);
    const marker = JSON.parse(deps.fs.readFileSync(kMarkerPath));
    expect(marker.hostFinalizationScheduled).toBe(true);
  });

  it("reports a sanitized error and lets the owner retry with a new operation", async () => {
    const deps = createDeps();
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd.startsWith("openclaw onboard")) {
        const error = new Error("Command failed: openclaw onboard");
        error.stderr = "invalid api key sk-live-abcdefghijklmnopqrstuvwxyz0123";
        throw error;
      }
      return "";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(kValidBody);
    const operation = await waitForSettled(deps, res.body.operationId);

    expect(operation.status).toBe("failed");
    const last = operation.events.at(-1);
    expect(last.event).toBe("error");
    expect(last.data.error).toBe(
      "Model provider authentication failed. Check your API key/token and try again.",
    );
    expect(JSON.stringify(operation.events)).not.toContain("sk-live-");
    expect(deps.fs.existsSync(kMarkerPath)).toBe(false);
    expect(deps.shellCmd).not.toHaveBeenCalledWith(kCompleteCmd, expect.anything());

    const status = await request(app).get("/api/onboard/status");
    expect(status.body.onboardingOperation).toBeUndefined();

    deps.shellCmd.mockImplementation(async () => "");
    const retry = await request(app).post("/api/onboard").send(kValidBody);
    expect(retry.status).toBe(202);
    expect(retry.body.operationId).not.toBe(res.body.operationId);
    expect((await waitForSettled(deps, retry.body.operationId)).status).toBe(
      "completed",
    );
  });

  it("still rejects invalid input synchronously", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/onboard")
      .send({ ...kValidBody, tailscaleApiToken: "" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Tailscale API access token is required",
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });
});

describe("onboarding operation runner", () => {
  it("schedules the after-completion task with a short delay after done", async () => {
    const operationEvents = createOperationEventsService();
    const timers = [];
    const runner = createOnboardingOperationRunner({
      operationEvents,
      setTimeoutImpl: (fn, delay) => timers.push({ fn, delay }),
    });
    const afterComplete = vi.fn();
    const { operationId, promise } = runner.start({
      run: async ({ onProgress }) => {
        onProgress({ phase: "configuring", label: "Configuring OpenClaw" });
        return { body: { ok: true }, afterComplete };
      },
    });
    await promise;

    const operation = operationEvents.getOperation(operationId);
    expect(operation.events.map((entry) => entry.event)).toEqual([
      "phase",
      "done",
    ]);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(kHostFinalizationDelayMs);
    expect(kHostFinalizationDelayMs).toBeGreaterThan(0);
    expect(afterComplete).not.toHaveBeenCalled();
    timers[0].fn();
    expect(afterComplete).toHaveBeenCalledTimes(1);
    expect(runner.getActiveOperationId()).toBe("");
  });

  it("does not schedule finalization when the setup fails", async () => {
    const operationEvents = createOperationEventsService();
    const setTimeoutImpl = vi.fn();
    const runner = createOnboardingOperationRunner({
      operationEvents,
      setTimeoutImpl,
      sanitizeError: () => "Setup failed cleanly",
    });
    const { operationId, promise } = runner.start({
      run: async () => {
        throw new Error("secret detail");
      },
    });
    await promise;
    expect(setTimeoutImpl).not.toHaveBeenCalled();
    expect(operationEvents.getOperation(operationId).events.at(-1)).toMatchObject({
      event: "error",
      data: { error: "Setup failed cleanly" },
    });
  });
});
