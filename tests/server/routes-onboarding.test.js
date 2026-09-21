const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const request = require("supertest");

const {
  registerOnboardingRoutes,
  scheduleAfterResponseTask,
} = require("../../lib/server/routes/onboarding");
const { kSetupDir } = require("../../lib/server/constants");

const createBaseDeps = ({
  onboarded = false,
  hasCodexOauth = false,
  hasClaudeCli = false,
  processStartedAtMs = Date.parse("2026-08-27T23:12:06.000Z"),
} = {}) => {
  const kOnboardingMarkerPath = "/tmp/alphaclaw/onboarded.json";
  return {
    fs: {
      mkdirSync: vi.fn(),
      existsSync: vi.fn((targetPath) =>
        onboarded ? targetPath === kOnboardingMarkerPath : false,
      ),
      statSync: vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      readdirSync: vi.fn(() => []),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(() => JSON.stringify(onboarded ? { onboarded: true } : {})),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
    },
    constants: {
      kRootDir: "/tmp/alphaclaw",
      OPENCLAW_DIR: "/tmp/openclaw",
      WORKSPACE_DIR: "/tmp/openclaw/workspace",
      kOnboardingMarkerPath,
      kSystemVars: new Set([
        "WEBHOOK_TOKEN",
        "OPENCLAW_GATEWAY_TOKEN",
        "GITHUB_TOKEN",
        "GITHUB_WORKSPACE_REPO",
      ]),
      kKnownKeys: new Set([
        "OPENAI_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
      ]),
    },
    shellCmd: vi.fn(async () => ""),
    gatewayEnv: vi.fn(() => ({
      HOME: "/tmp/alphaclaw",
      OPENCLAW_HOME: "/tmp/alphaclaw",
      OPENCLAW_CONFIG_PATH: "/tmp/openclaw/openclaw.json",
      OPENCLAW_GATEWAY_TOKEN: "tok",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: "/tmp/openclaw",
      XDG_CONFIG_HOME: "/tmp/openclaw",
      NODE_COMPILE_CACHE: "/tmp/alphaclaw/cache/openclaw-compile-cache",
    })),
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    isOnboarded: vi.fn(() => onboarded),
    isGatewayRunning: vi.fn(async () => true),
    isOnboardingRuntimeReady: vi.fn(async () => true),
    resolveModelProvider: vi.fn((modelKey) => String(modelKey).split("/")[0]),
    hasCodexOauthProfile: vi.fn(() => hasCodexOauth),
    hasClaudeCliProfile: vi.fn(() => hasClaudeCli),
    authProfiles: {
      getEnvVarForApiKeyProvider: vi.fn((provider) => {
        const envKeys = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          google: "GEMINI_API_KEY",
          openrouter: "OPENROUTER_API_KEY",
          "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
        };
        return envKeys[provider] || "";
      }),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      hasClaudeCliProfile: vi.fn(() => hasClaudeCli),
      upsertClaudeCliProfile: vi.fn(),
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
    getProcessStartedAtMs: vi.fn(() => processStartedAtMs),
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerOnboardingRoutes({ app, ...deps });
  return app;
};

const makeValidBody = () => ({
  modelKey: "openai/gpt-5.1-codex",
  tailscaleApiToken: "tskey-api-test_123456789",
  vars: [
    { key: "OPENAI_API_KEY", value: "sk-test-123456789" },
    { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
  ],
});

const kExpectedOnboardSuccess = {
  ok: true,
  setupUrl: "https://alphaclaw.tail123.ts.net",
  publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
  tailscaleDns: "alphaclaw.tail123.ts.net",
};

const failShellCommand = (deps, matcher, error) => {
  deps.shellCmd.mockImplementation(async (cmd) => {
    if (matcher(cmd)) throw error;
    return "";
  });
};

describe("server/routes/onboarding", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("returns onboard status from dependency", async () => {
    const deps = createBaseDeps({ onboarded: true });
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      onboarded: true,
      initialRuntimePending: false,
      workspaceBootstrap: { complete: false, reason: "workspace_missing" },
    });
  });

  it("reports a pending workspace bootstrap on the status endpoint", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.existsSync.mockImplementation((targetPath) =>
      [
        deps.constants.kOnboardingMarkerPath,
        deps.constants.WORKSPACE_DIR,
        path.join(deps.constants.WORKSPACE_DIR, "BOOTSTRAP.md"),
      ].includes(targetPath),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/status");

    expect(res.status).toBe(200);
    expect(res.body.workspaceBootstrap).toEqual({
      complete: false,
      reason: "bootstrap_pending",
    });
  });

  it("reports a completed workspace bootstrap on the status endpoint", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.existsSync.mockImplementation((targetPath) =>
      [
        deps.constants.kOnboardingMarkerPath,
        deps.constants.WORKSPACE_DIR,
        path.join(deps.constants.WORKSPACE_DIR, "IDENTITY.md"),
      ].includes(targetPath),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/status");

    expect(res.status).toBe(200);
    expect(res.body.workspaceBootstrap).toEqual({
      complete: true,
      reason: "bootstrap_file_absent",
    });
  });

  it("returns final setup details from the onboarding marker", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValueOnce(
      JSON.stringify({
        onboarded: true,
        setupUrl: "https://alphaclaw.tail123.ts.net",
        publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
        tailscaleDns: "alphaclaw.tail123.ts.net",
        handoffViaBootstrapOrigin: true,
      }),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      onboarded: true,
      initialRuntimePending: false,
      workspaceBootstrap: { complete: false, reason: "workspace_missing" },
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      tailscaleDns: "alphaclaw.tail123.ts.net",
      handoffViaBootstrapOrigin: true,
    });
  });

  it("persists and returns bootstrap-origin handoff capability", async () => {
    const deps = createBaseDeps();
    deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mockResolvedValueOnce({
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      dnsName: "alphaclaw.tail123.ts.net",
      handoffViaBootstrapOrigin: true,
    });
    const res = await request(createApp(deps))
      .post("/api/onboard")
      .send(makeValidBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...kExpectedOnboardSuccess,
      handoffViaBootstrapOrigin: true,
    });
    const markerCall = deps.fs.writeFileSync.mock.calls.find(
      ([targetPath]) => targetPath === deps.constants.kOnboardingMarkerPath,
    );
    expect(JSON.parse(markerCall[1]).handoffViaBootstrapOrigin).toBe(true);
  });

  it("keeps the runtime image unavailable in the process that scheduled finalization", async () => {
    const markedAt = "2026-08-27T23:11:37.000Z";
    const deps = createBaseDeps({
      onboarded: true,
      processStartedAtMs: Date.parse(markedAt) - 60_000,
    });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        onboarded: true,
        markedAt,
        hostFinalizationScheduled: true,
      }),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/runtime-ready.svg");

    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("serves the runtime image only from the successor process", async () => {
    const markedAt = "2026-08-27T23:11:37.000Z";
    const deps = createBaseDeps({
      onboarded: true,
      processStartedAtMs: Date.parse(markedAt) + 29_000,
    });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        onboarded: true,
        markedAt,
        hostFinalizationScheduled: true,
      }),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/runtime-ready.svg");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(Buffer.from(res.body).toString("utf8")).toContain("<svg");
  });

  it("keeps the successor runtime image unavailable until the gateway is listening", async () => {
    const markedAt = "2026-08-27T23:11:37.000Z";
    const deps = createBaseDeps({
      onboarded: true,
      processStartedAtMs: Date.parse(markedAt) + 29_000,
    });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        onboarded: true,
        markedAt,
        hostFinalizationScheduled: true,
      }),
    );
    deps.isGatewayRunning.mockResolvedValue(false);
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/runtime-ready.svg");

    expect(deps.isOnboardingRuntimeReady).toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("exposes the final URL on the authenticated handoff lane before readiness", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        onboarded: true,
        setupUrl: "https://alphaclaw.tail123.ts.net",
        handoffViaBootstrapOrigin: true,
      }),
    );
    deps.isOnboardingRuntimeReady.mockResolvedValue(false);

    const res = await request(createApp(deps)).head(
      "/api/onboard/runtime-ready.svg",
    );

    expect(res.status).toBe(503);
    expect(res.headers["x-clawbridge-setup-url"]).toBe(
      "https://alphaclaw.tail123.ts.net",
    );
  });

  it("gates direct login until the successor runtime is ready, then preserves repair access", async () => {
    const deps = createBaseDeps({ onboarded: true, processStartedAtMs: Date.parse("2026-09-08T17:41:00Z") });
    let marker = { onboarded: true, hostFinalizationScheduled: true, initialRuntimeCheckRequired: true, markedAt: "2026-09-08T17:40:00Z" };
    deps.fs.readFileSync.mockImplementation(() => JSON.stringify(marker));
    deps.fs.writeFileSync.mockImplementation((file, data) => { marker = JSON.parse(data); });
    deps.isOnboardingRuntimeReady.mockResolvedValue(false);
    const app = createApp(deps);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(true);
    expect(marker.initialRuntimeReadyAt).toBeUndefined();
    deps.isOnboardingRuntimeReady.mockResolvedValue(true);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(false);
    expect(marker.initialRuntimeReadyAt).toBeTruthy();
    deps.isOnboardingRuntimeReady.mockResolvedValue(false);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(false);
  });

  it("does not reuse a restored source instance's readiness proof", async () => {
    const deps = createBaseDeps({ onboarded: true, processStartedAtMs: Date.parse("2026-09-08T17:41:00Z") });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true, hostFinalizationScheduled: true, initialRuntimeCheckRequired: true,
      markedAt: "2026-09-08T17:40:00Z", initialRuntimeReadyAt: "2026-09-08T17:40:30Z", initialRuntimeReadyInstanceId: "inst_source" }));
    deps.isOnboardingRuntimeReady.mockResolvedValue(false);
    expect((await request(createApp(deps)).get("/api/onboard/status")).body.initialRuntimePending).toBe(true);
  });

  it.each(["unreadable", "malformed"])("keeps direct login gated for an %s onboarding marker", async (failure) => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockImplementation(() => {
      if (failure === "unreadable") throw new Error("permission denied");
      return "{partial";
    });
    const app = createApp(deps);
    const status = (await request(app).get("/api/onboard/status")).body;
    expect(status.onboarded).toBe(true);
    expect(status.initialRuntimePending).toBe(true);
    expect((await request(app).get("/api/onboard/runtime-ready.svg")).status).toBe(503);
  });

  it("does not certify readiness if the marker reread fails before persistence", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValueOnce(JSON.stringify({ onboarded: true })).mockReturnValue("{partial");
    expect((await request(createApp(deps)).get("/api/onboard/runtime-ready.svg")).status).toBe(503);
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("preserves the onboarding marker after a partial readiness write fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-atomic-"));
    const markerPath = path.join(root, "onboarded.json");
    const original = JSON.stringify({ onboarded: true, initialRuntimeCheckRequired: true });
    fs.writeFileSync(markerPath, original);
    try {
      const deps = createBaseDeps({ onboarded: true });
      deps.constants.kOnboardingMarkerPath = markerPath;
      deps.fs = { ...fs, writeFileSync: (file, data) => {
        fs.writeFileSync(file, data.slice(0, 10));
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      } };
      const app = createApp(deps);
      expect((await request(app).get("/api/onboard/runtime-ready.svg")).status).toBe(503);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(original);
      expect(fs.readdirSync(root)).toEqual(["onboarded.json"]);
      deps.isOnboardingRuntimeReady.mockResolvedValue(false);
      expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed if initial readiness cannot be persisted", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true }));
    deps.fs.writeFileSync.mockImplementation(() => { throw new Error("disk full"); });
    expect((await request(createApp(deps)).get("/api/onboard/runtime-ready.svg")).status).toBe(503);
  });

  it("cannot certify the outgoing setup process through a direct login", async () => {
    const deps = createBaseDeps({ onboarded: true, processStartedAtMs: Date.parse("2026-09-08T17:39:00Z") });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true, hostFinalizationScheduled: true, initialRuntimeCheckRequired: true, markedAt: "2026-09-08T17:40:00Z" }));
    const app = createApp(deps);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(true);
    expect(deps.isOnboardingRuntimeReady).not.toHaveBeenCalled();
  });

  it("keeps historical installations accessible for repair after upgrade", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true, hostFinalizationScheduled: true, markedAt: "2026-09-07T12:00:00Z" }));
    deps.isOnboardingRuntimeReady.mockResolvedValue(false);
    expect((await request(createApp(deps)).get("/api/onboard/status")).body.initialRuntimePending).toBe(false);
    expect(deps.isOnboardingRuntimeReady).not.toHaveBeenCalled();
  });

  it("finishes readiness polling when finalization uses its no-restart fallback", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true, hostFinalizationScheduled: false, initialRuntimeCheckRequired: true }));
    deps.isOnboardingRuntimeReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    const app = createApp(deps);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(true);
    expect((await request(app).get("/api/onboard/status")).body.initialRuntimePending).toBe(false);
  });

  it("does not hand off a listening gateway before chat and Vault are ready", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ onboarded: true }));
    deps.isOnboardingRuntimeReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    const app = createApp(deps);
    expect((await request(app).get("/api/onboard/runtime-ready.svg")).status).toBe(503);
    expect((await request(app).get("/api/onboard/runtime-ready.svg")).status).toBe(200);
  });

  it("keeps first entry gated until the bootstrap kickoff has a durable decision", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({ onboarded: true, initialRuntimeCheckRequired: true }),
    );
    deps.isInitialHandoffReady = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const app = createApp(deps);

    expect(
      (await request(app).get("/api/onboard/status")).body.initialRuntimePending,
    ).toBe(true);
    expect(
      (await request(app).get("/api/onboard/status")).body.initialRuntimePending,
    ).toBe(false);
    expect(deps.isOnboardingRuntimeReady).not.toHaveBeenCalled();
  });


  it("fails the readiness image closed when the gateway check errors", async () => {
    const deps = createBaseDeps({ onboarded: true });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({ onboarded: true, hostFinalizationScheduled: false }),
    );
    deps.isGatewayRunning.mockRejectedValue(new Error("socket failure"));
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/runtime-ready.svg");

    expect(res.status).toBe(503);
  });

  it("serves the runtime image when finalization scheduling was cancelled", async () => {
    const deps = createBaseDeps({
      onboarded: true,
      processStartedAtMs: Date.parse("2026-08-27T23:10:00.000Z"),
    });
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        onboarded: true,
        markedAt: "2026-08-27T23:11:37.000Z",
        hostFinalizationScheduled: false,
      }),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/onboard/runtime-ready.svg");

    expect(res.status).toBe(200);
  });

  it("short-circuits when already onboarded", async () => {
    const deps = createBaseDeps({ onboarded: true });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Already onboarded" });
  });

  it("validates missing vars array", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({ modelKey: "openai/gpt-5.1" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Missing vars array" });
  });

  it("validates missing model selection", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({ vars: [] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "A model selection is required" });
  });

  it("rejects missing Tailscale API token", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    const body = makeValidBody();
    delete body.tailscaleApiToken;

    const res = await request(app).post("/api/onboard").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Tailscale API access token is required",
    });
    expect(deps.tailscaleFinalizer.finalizeTailscaleOnboarding).not.toHaveBeenCalled();
  });

  it("fails early when host finalization preflight is unavailable", async () => {
    const deps = createBaseDeps();
    const err = new Error("Command failed");
    err.stderr =
      "sudo: /usr/local/sbin/alphaclaw-host-finalize-setup: command not found";
    failShellCommand(
      deps,
      (cmd) =>
        cmd ===
        "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup check",
      err,
    );
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
    });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain(
      "This host was likely provisioned with an older clawctl",
    );
    expect(res.body.error).toContain(
      "/usr/local/sbin/alphaclaw-host-finalize-setup",
    );
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
    expect(deps.tailscaleFinalizer.finalizeTailscaleOnboarding).not.toHaveBeenCalled();
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("allows onboarding without any channel tokens", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    const body = makeValidBody();
    body.vars = body.vars.filter((entry) => entry.key !== "TELEGRAM_BOT_TOKEN");

    const res = await request(app).post("/api/onboard").send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
  });

  it("runs host finalization check before setup work and complete after final setup", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(200);
    const shellCommands = deps.shellCmd.mock.calls.map(([cmd]) => cmd);
    const checkIndex = shellCommands.indexOf(
      "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup check",
    );
    const completeIndex = shellCommands.indexOf(
      "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup complete",
    );
    expect(checkIndex).toBe(0);
    expect(completeIndex).toBeGreaterThan(-1);
    expect(
      deps.shellCmd.mock.invocationCallOrder[checkIndex],
    ).toBeLessThan(deps.writeEnvFile.mock.invocationCallOrder[0]);

    const markerWriteIndex = deps.fs.writeFileSync.mock.calls.findIndex(
      ([targetPath]) => targetPath === "/tmp/alphaclaw/onboarded.json",
    );
    expect(markerWriteIndex).toBeGreaterThan(-1);
    const completeOrder = deps.shellCmd.mock.invocationCallOrder[completeIndex];
    expect(completeOrder).toBeGreaterThan(
      deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mock.invocationCallOrder[0],
    );
    expect(completeOrder).toBeGreaterThan(
      deps.fs.writeFileSync.mock.invocationCallOrder[markerWriteIndex],
    );
    expect(completeOrder).toBeGreaterThan(
      deps.ensureGatewayProxyConfig.mock.invocationCallOrder[0],
    );
    expect(completeOrder).toBeGreaterThan(
      deps.runOnboardedBootSequence.mock.invocationCallOrder[0],
    );
  });

  it("returns the onboarding response before host finalization complete resolves", async () => {
    const deps = createBaseDeps();
    let completeStarted = false;
    let releaseComplete = () => {};
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd === "sudo -n /usr/local/sbin/alphaclaw-host-finalize-setup complete") {
        completeStarted = true;
        return new Promise((resolve) => {
          releaseComplete = resolve;
        });
      }
      return "";
    });
    const app = createApp(deps);

    const res = await Promise.race([
      request(app).post("/api/onboard").send(makeValidBody()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("onboarding response timed out")), 1000),
      ),
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(completeStarted).toBe(true);
    releaseComplete("");
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("does not mark onboarding complete when Tailscale does not return a setup URL", async () => {
    const deps = createBaseDeps();
    deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mockResolvedValueOnce({
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      dnsName: "alphaclaw.tail123.ts.net",
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: "Tailscale finalization completed without a final setup URL",
    });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
      "/tmp/alphaclaw/onboarded.json",
      expect.any(String),
    );
    expect(deps.ensureGatewayProxyConfig).not.toHaveBeenCalled();
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("prepares the Agent Vault runtime before completing security-gateway onboarding", async () => {
    const deps = createBaseDeps();
    deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mockResolvedValueOnce({
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      dnsName: "alphaclaw.tail123.ts.net",
      agentVaultOperatorUrl:
        "https://agent-vault-inst-test.tail123.ts.net",
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(200);
    expect(deps.prepareAgentVaultRuntime).toHaveBeenCalledOnce();
    const markerWrite = deps.fs.writeFileSync.mock.calls.findIndex(
      ([targetPath]) => targetPath === "/tmp/alphaclaw/onboarded.json",
    );
    expect(markerWrite).toBeGreaterThan(-1);
    expect(
      deps.prepareAgentVaultRuntime.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deps.fs.writeFileSync.mock.invocationCallOrder[markerWrite],
    );
  });

  it("does not complete onboarding when automatic Agent Vault initialization is pending", async () => {
    const deps = createBaseDeps();
    deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mockResolvedValueOnce({
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      dnsName: "alphaclaw.tail123.ts.net",
      agentVaultOperatorUrl:
        "https://agent-vault-inst-test.tail123.ts.net",
    });
    deps.prepareAgentVaultRuntime.mockResolvedValueOnce({
      ready: false,
      reason: "owner_pending",
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      "Automatic Agent Vault initialization did not complete",
    );
    expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
      "/tmp/alphaclaw/onboarded.json",
      expect.any(String),
    );
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("passes OpenRouter auth-choice flags during onboarding for openrouter models", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openrouter/anthropic/claude-sonnet-4-6",
      vars: [{ key: "OPENROUTER_API_KEY", value: "sk-or-test-123456789" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) =>
        cmd.includes(
          'openclaw onboard "--non-interactive" "--accept-risk"',
        ) &&
        cmd.includes('"--auth-choice" "openrouter-api-key"') &&
        cmd.includes('"--secret-input-mode" "ref"') &&
        !cmd.includes("sk-or-test-123456789"),
      ),
    ).toBe(true);
  });

  it("passes Vercel AI Gateway auth-choice flags during onboarding for gateway-backed models", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
      vars: [{ key: "AI_GATEWAY_API_KEY", value: "vck_test_123456789" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) =>
        cmd.includes('"--auth-choice" "ai-gateway-api-key"') &&
        cmd.includes('"--secret-input-mode" "ref"') &&
        !cmd.includes("vck_test_123456789"),
      ),
    ).toBe(true);
  });

  it("rejects Vercel AI Gateway keys with the wrong prefix during onboarding", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
      vars: [{ key: "AI_GATEWAY_API_KEY", value: "not-a-vercel-key" }],
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "AI_GATEWAY_API_KEY must start with vck_",
    });
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("does not initialize or sync a repository during fresh onboarding", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test-123456789" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) => /(^|\s)git\s/.test(cmd)),
    ).toBe(false);
    expect(deps.tailscaleFinalizer.finalizeTailscaleOnboarding).toHaveBeenCalledWith({
      tailscaleApiToken: "tskey-api-test_123456789",
    });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("system-sync"),
      expect.anything(),
    );
  });

  it("does not persist Tailscale API tokens submitted in vars", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test-123456789" },
        { key: "TAILSCALE_API_TOKEN", value: "tskey-api-should-not-save" },
      ],
    });

    expect(res.status).toBe(200);
    const savedVars = deps.writeEnvFile.mock.calls[0][0];
    expect(savedVars).toEqual(
      expect.arrayContaining([
        { key: "OPENAI_API_KEY", value: "sk-test-123456789" },
      ]),
    );
    expect(
      savedVars.some((entry) => String(entry.key).startsWith("TAILSCALE_")),
    ).toBe(false);
  });

  it("rejects overly large env var values before running onboarding", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    const body = makeValidBody();
    body.vars = body.vars.map((entry) =>
      entry.key === "OPENAI_API_KEY"
        ? { ...entry, value: "x".repeat(5000) }
        : entry,
    );

    const res = await request(app).post("/api/onboard").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Value too long for OPENAI_API_KEY (max 4096 chars)",
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("requires codex oauth for openai-codex provider", async () => {
    const deps = createBaseDeps({ hasCodexOauth: false });
    const app = createApp(deps);

    const body = {
      modelKey: "openai-codex/gpt-5.3-codex",
      vars: [
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
      ],
    };

    const res = await request(app).post("/api/onboard").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Connect OpenAI Codex OAuth before continuing",
    });
  });

  it("writes a Gateway token into the env file before running onboard on a fresh host", async () => {
    const deps = createBaseDeps();
    const savedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const app = createApp(deps);
      const res = await request(app).post("/api/onboard").send({
        tailscaleApiToken: "tskey-api-test_123456789",
        modelKey: "vercel-ai-gateway/anthropic/claude-opus-5",
        vars: [{ key: "AI_GATEWAY_API_KEY", value: "vck_live_test" }],
      });
      expect(res.status).toBe(200);
      const written = deps.writeEnvFile.mock.calls[0][0];
      const token = written.find((item) => item.key === "OPENCLAW_GATEWAY_TOKEN");
      expect(token?.value).toMatch(/^[0-9a-f]{64}$/);
      // The env file is written (and reloaded) before the onboard child runs.
      expect(deps.writeEnvFile.mock.invocationCallOrder[0]).toBeLessThan(
        deps.shellCmd.mock.invocationCallOrder.find((_, i) =>
          String(deps.shellCmd.mock.calls[i][0]).startsWith("openclaw onboard"),
        ),
      );
    } finally {
      if (savedToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = savedToken;
    }
  });

  it("configures and reconciles the Codex runtime for OpenAI models with Codex OAuth", async () => {
    const deps = createBaseDeps({ hasCodexOauth: true });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(deps.shellCmd).toHaveBeenCalledWith(
      'openclaw models set "openai/gpt-5.5"',
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: "tok" }),
      }),
    );
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) =>
        cmd.includes('"--auth-choice" "skip"'),
      ),
    ).toBe(true);
    const codexInstallCall = deps.shellCmd.mock.calls.find(
      ([cmd]) => cmd === "openclaw plugins install codex --accept-capabilities",
    );
    const onboardCall = deps.shellCmd.mock.calls.find(([cmd]) =>
      cmd.startsWith("openclaw onboard "),
    );
    expect(codexInstallCall).toBeDefined();
    expect(
      deps.shellCmd.mock.invocationCallOrder[
        deps.shellCmd.mock.calls.indexOf(codexInstallCall)
      ],
    ).toBeLessThan(
      deps.shellCmd.mock.invocationCallOrder[
        deps.shellCmd.mock.calls.indexOf(onboardCall)
      ],
    );
    const openclawWriteCall = deps.fs.writeFileSync.mock.calls.find(
      ([targetPath]) => targetPath === "/tmp/openclaw/openclaw.json",
    );
    const writtenConfig = JSON.parse(openclawWriteCall[1]);
    expect(writtenConfig.agents.defaults.agentRuntime).toBeUndefined();
    expect(writtenConfig.models.providers.openai.agentRuntime).toEqual({
      id: "codex",
    });
    expect(writtenConfig.plugins.allow).toContain("codex");
    expect(writtenConfig.plugins.entries.codex).toEqual({ enabled: true });
    expect(deps.reconcileOpenclawPlugins).toHaveBeenCalledWith({
      rootDir: "/tmp/alphaclaw",
      openclawDir: "/tmp/openclaw",
      fsModule: deps.fs,
      logger: console,
      env: process.env,
    });
    expect(
      deps.reconcileOpenclawPlugins.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.runOnboardedBootSequence.mock.invocationCallOrder[0]);
  });

  it("does not reinstall the Codex plugin when it is already present", async () => {
    const deps = createBaseDeps({ hasCodexOauth: true });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    deps.shellCmd.mockImplementation(async (cmd) => {
      if (cmd === "openclaw plugins list --json") {
        return JSON.stringify({ plugins: [{ id: "codex" }] });
      }
      return "";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(200);
    expect(deps.shellCmd).toHaveBeenCalledWith(
      "openclaw plugins list --json",
      expect.objectContaining({ timeout: 30000 }),
    );
    expect(deps.shellCmd).not.toHaveBeenCalledWith(
      "openclaw plugins install codex --accept-capabilities",
      expect.anything(),
    );
  });

  it("canonicalizes openai-codex model keys when configuring the Codex runtime", async () => {
    const deps = createBaseDeps({ hasCodexOauth: true });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai-codex/gpt-5.5",
      agentRuntimeId: "codex",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(deps.shellCmd).toHaveBeenCalledWith(
      'openclaw models set "openai/gpt-5.5"',
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: "tok" }),
      }),
    );
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) =>
        cmd.includes('"--auth-choice" "skip"'),
      ),
    ).toBe(true);
  });

  it("configures and reconciles the Claude CLI runtime for Claude CLI models", async () => {
    const deps = createBaseDeps({ hasClaudeCli: true });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "claude-cli/claude-opus-4-8",
      agentRuntimeId: "claude-cli",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(deps.shellCmd).toHaveBeenCalledWith(
      'openclaw models set "anthropic/claude-opus-4-8"',
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: "tok" }),
      }),
    );
    expect(
      deps.shellCmd.mock.calls.some(([cmd]) =>
        cmd.includes('"--auth-choice" "skip"'),
      ),
    ).toBe(true);
    const openclawWriteCall = deps.fs.writeFileSync.mock.calls.find(
      ([targetPath]) => targetPath === "/tmp/openclaw/openclaw.json",
    );
    const writtenConfig = JSON.parse(openclawWriteCall[1]);
    expect(
      writtenConfig.agents.defaults.models["anthropic/claude-opus-4-8"].agentRuntime,
    ).toEqual({ id: "claude-cli" });
    expect(writtenConfig.plugins.allow).toContain("anthropic");
    expect(writtenConfig.plugins.entries.anthropic).toEqual({ enabled: true });
  });

  it("rejects canonical OpenAI models with Codex OAuth when runtime is not requested", async () => {
    const deps = createBaseDeps({ hasCodexOauth: true });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.5",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: 'Missing credentials for selected provider "openai"',
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("fails onboarding before gateway start when managed plugin reconciliation fails", async () => {
    const deps = createBaseDeps();
    deps.reconcileOpenclawPlugins.mockImplementation(() => {
      throw new Error("install failed");
    });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error:
        "OpenClaw plugin installation failed. Please retry setup; if it persists, check package registry/network access for OpenClaw plugins.",
    });
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("keeps onboarding incomplete when Tailscale finalization fails", async () => {
    const deps = createBaseDeps();
    deps.tailscaleFinalizer.finalizeTailscaleOnboarding.mockRejectedValue(
      new Error("Tailscale setup failed"),
    );
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: "Tailscale setup failed",
    });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
      "/tmp/alphaclaw/onboarded.json",
      expect.any(String),
    );
    expect(deps.runOnboardedBootSequence).not.toHaveBeenCalled();
  });

  it("rejects anthropic setup tokens with the wrong prefix", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "anthropic/claude-opus-4-6",
      vars: [
        { key: "ANTHROPIC_TOKEN", value: "sk-ant-api03-not-a-setup-token" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "ANTHROPIC_TOKEN must start with sk-ant-oat01-",
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("writes managed bootstrap state during successful onboarding", async () => {
    const deps = createBaseDeps();
    deps.getBaseUrl.mockReturnValue("https://setup.example.com");
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      if (p === path.join(kSetupDir, "core-prompts", "TOOLS.md")) return "Setup: {{SETUP_UI_URL}}";
      if (p === path.join(kSetupDir, "core-prompts", "AGENTS.md")) {
        return "Contract: {{MANAGED_CAPABILITY_CONTRACT_REF}}";
      }
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kExpectedOnboardSuccess);
    expect(deps.runOnboardedBootSequence).toHaveBeenCalledTimes(1);
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "openai",
      "sk-test-123456789",
    );
    expect(deps.authProfiles.syncConfigAuthReferencesForAgent).toHaveBeenCalledTimes(1);
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/openclaw/workspace/hooks/bootstrap/AGENTS.md",
      "Contract: teamyou.managed-capabilities/v1@2026-09-18.1",
    );
    const toolsWriteCall = deps.fs.writeFileSync.mock.calls
      .filter(
      ([path]) => path === "/tmp/openclaw/workspace/hooks/bootstrap/TOOLS.md",
      )
      .at(-1);
    expect(toolsWriteCall).toBeTruthy();
    expect(toolsWriteCall[1]).toContain("https://alphaclaw.tail123.ts.net");
    expect(deps.ensureGatewayProxyConfig).toHaveBeenCalledWith(
      "https://alphaclaw.tail123.ts.net",
    );

    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/alphaclaw/onboarded.json",
      expect.stringContaining('"reason": "onboarding_complete"'),
    );

    expect(
      deps.shellCmd.mock.calls.some(([cmd]) => /(^|\s)git\s/.test(cmd)),
    ).toBe(false);

    const openclawWriteCall = deps.fs.writeFileSync.mock.calls.find(
      ([path]) => path === "/tmp/openclaw/openclaw.json",
    );
    expect(openclawWriteCall).toBeTruthy();
    const writtenConfig = JSON.parse(openclawWriteCall[1]);
    expect(writtenConfig.hooks.internal.enabled).toBe(true);
    expect(writtenConfig.hooks.internal.entries["bootstrap-extra-files"]).toEqual({
      enabled: true,
      paths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/TOOLS.md"],
    });
  });

  it("seeds anthropic api key auth profile during onboarding", async () => {
    const deps = createBaseDeps();
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      if (p === path.join(kSetupDir, "core-prompts", "TOOLS.md")) return "Setup: {{SETUP_UI_URL}}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "anthropic/claude-opus-4-6",
      vars: [
        { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-123456789" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
      ],
    });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "anthropic",
      "sk-ant-api03-123456789",
    );
    expect(deps.authProfiles.syncConfigAuthReferencesForAgent).toHaveBeenCalledTimes(1);
  });

  it("removes stale anthropic token env state when onboarding with an api key", async () => {
    const deps = createBaseDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "ANTHROPIC_TOKEN", value: "sk-ant-oat01-stale-token" },
      { key: "GITHUB_TOKEN", value: "ghp_old" },
      { key: "GITHUB_WORKSPACE_REPO", value: "owner/old" },
    ]);
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      if (p === path.join(kSetupDir, "core-prompts", "TOOLS.md")) return "Setup: {{SETUP_UI_URL}}";
      return "{}";
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "anthropic/claude-opus-4-6",
      vars: [
        { key: "ANTHROPIC_API_KEY", value: "sk-ant-api-fresh-123456789" },
        { key: "GITHUB_TOKEN", value: "ghp_test_123456789" },
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" },
      ],
    });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalled();
    const savedVars = deps.writeEnvFile.mock.calls.at(-1)[0];
    expect(savedVars.some((entry) => entry.key === "ANTHROPIC_TOKEN")).toBe(false);
    expect(savedVars.some((entry) => entry.key === "GITHUB_TOKEN")).toBe(false);
    expect(
      savedVars.some((entry) => entry.key === "GITHUB_WORKSPACE_REPO"),
    ).toBe(false);

    const onboardCall = deps.shellCmd.mock.calls.find(([cmd]) =>
      cmd.startsWith("openclaw onboard "),
    );
    expect(onboardCall).toBeTruthy();
    expect(onboardCall[0]).toContain('"--secret-input-mode" "ref"');
    expect(onboardCall[0]).not.toContain("sk-ant-api-fresh-123456789");
    expect(onboardCall[0]).not.toContain("--token-provider");
    expect(onboardCall[0]).not.toContain("sk-ant-oat01-stale-token");
    expect(onboardCall[1]).toMatchObject({
      env: expect.objectContaining({
        HOME: expect.any(String),
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw/openclaw.json",
        OPENCLAW_STATE_DIR: "/tmp/openclaw",
        XDG_CONFIG_HOME: "/tmp/openclaw",
      }),
    });
  });

  it("sanitizes onboarding command failures to avoid leaking secrets", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    failShellCommand(
      deps,
      (cmd) => cmd.startsWith("openclaw onboard "),
      new Error('Command failed: openclaw onboard --openai-api-key "sk-test-secret-value"'),
    );

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: "Onboarding command failed. Please verify credentials and try again.",
    });
  });

  it("redacts fine-grained GitHub tokens from onboarding errors", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    failShellCommand(
      deps,
      (cmd) => cmd.startsWith("openclaw onboard "),
      new Error('boom github_pat_super_secret_value openclaw onboard'),
    );

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).not.toContain("github_pat_super_secret_value");
    expect(res.body.error).toContain("***");
  });

  it("returns a helpful OOM message when onboarding runs out of memory", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    failShellCommand(
      deps,
      (cmd) => cmd.startsWith("openclaw onboard "),
      new Error("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"),
    );

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error:
        "Onboarding ran out of memory. Please retry, and if it persists increase instance memory.",
    });
  });

  it("does not misclassify generic permission failures", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    const err = new Error("Command failed: openclaw onboard");
    err.stderr = "remote: Permission denied";
    failShellCommand(deps, (cmd) => cmd.startsWith("openclaw onboard "), err);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.1-codex",
      vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123456789" }],
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: "Onboarding command failed. Please verify credentials and try again.",
    });
  });

  it("returns a plugin-specific message for OpenClaw plugin install failures", async () => {
    const deps = createBaseDeps({ hasCodexOauth: true });
    deps.fs.readFileSync.mockImplementation((p) => {
      if (p === "/tmp/openclaw/openclaw.json") return "{}";
      return "{}";
    });
    deps.reconcileOpenclawPlugins.mockRejectedValueOnce(
      new Error("npm ERR! 404 Not Found - @openclaw/codex"),
    );
    const app = createApp(deps);

    const res = await request(app).post("/api/onboard").send({
      tailscaleApiToken: "tskey-api-test_123456789",
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      vars: [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_123456789" }],
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error:
        "OpenClaw plugin installation failed. Please retry setup; if it persists, check package registry/network access for OpenClaw plugins.",
    });
  });

  it("returns a helpful provider auth message for invalid credentials", async () => {
    const deps = createBaseDeps();
    const app = createApp(deps);
    failShellCommand(
      deps,
      (cmd) => cmd.startsWith("openclaw onboard "),
      new Error("invalid_api_key"),
    );

    const res = await request(app).post("/api/onboard").send(makeValidBody());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error:
        "Model provider authentication failed. Check your API key/token and try again.",
    });
  });

  it("does not expose the retired standalone OpenClaw import endpoints", async () => {
    const app = createApp(createBaseDeps());

    const scan = await request(app).post("/api/onboard/import/scan").send({});
    const apply = await request(app).post("/api/onboard/import/apply").send({});

    expect(scan.status).toBe(404);
    expect(apply.status).toBe(404);
  });
});

describe("scheduleAfterResponseTask", () => {
  const { EventEmitter } = require("events");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the task once when the response finishes normally", () => {
    const res = new EventEmitter();
    const task = vi.fn();
    scheduleAfterResponseTask(res, task);
    res.emit("finish");
    res.emit("close");
    vi.advanceTimersByTime(60000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs the task when the connection closes without finishing", () => {
    const res = new EventEmitter();
    const task = vi.fn();
    scheduleAfterResponseTask(res, task);
    res.emit("close");
    vi.advanceTimersByTime(60000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("falls back to the timer when the socket was already dead", () => {
    // An upstream proxy that cut the connection mid-onboard leaves a response
    // that emits neither "finish" nor "close" after the handler completes;
    // host finalization must still run.
    const res = new EventEmitter();
    const task = vi.fn();
    scheduleAfterResponseTask(res, task, { fallbackDelayMs: 10000 });
    vi.advanceTimersByTime(9999);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
