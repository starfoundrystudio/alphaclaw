const fs = require("fs");
const os = require("os");
const path = require("path");

describe("Agent Vault onboarding readiness", () => {
  let rootDir;
  let oldRoot;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "alphaclaw-vault-readiness-"),
    );
    oldRoot = process.env.ALPHACLAW_ROOT_DIR;
    process.env.ALPHACLAW_ROOT_DIR = rootDir;
  });
  afterEach(() => {
    if (oldRoot === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
    else process.env.ALPHACLAW_ROOT_DIR = oldRoot;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  it("reconciles Vault configuration before the first managed gateway can launch", async () => {
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    const { writeAgentVaultRuntime } = require("../../lib/server/agent-vault/runtime-store");
    writeAgentVaultRuntime({ token: "av_runtime_token_123456789", vault: "default", mode: "brokered",
      operatorUrl: "https://vault.tail123.ts.net", tokenAcknowledged: true, handoffComplete: true });
    const { createAgentVaultService } = require("../../lib/server/agent-vault/service");
    const { createGatewayBootPreparation } = require("../../lib/server/gateway-boot-preparation");
    const restart = vi.fn();
    let boot;
    const applyRuntime = vi.fn(async () => { if (boot.hasStarted()) restart(); });
    const service = createAgentVaultService({
      env: { ALPHACLAW_CONNECTIVITY_MODE: "security_gateway" }, openclawDir,
      fetchImpl: async () => Response.json({ services: [], available_credentials: [] }),
      readEnvFile: () => [], writeEnvFile: vi.fn(), reloadEnv: vi.fn(),
      onRuntimeRestartRequired: applyRuntime,
    });
    const start = vi.fn(() => {
      const config = JSON.parse(fs.readFileSync(configPath));
      expect(config.proxy.enabled).toBe(true);
      expect(config.plugins.deny.length).toBeGreaterThan(0);
    });
    boot = createGatewayBootPreparation({ prepare: () => service.reconcileRuntime(), start });
    await Promise.all([boot.start(), service.reconcileRuntime()]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(applyRuntime).toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(await service.isRuntimeReady()).toBe(true);
    // Later configuration changes still request a real restart.
    const config = JSON.parse(fs.readFileSync(configPath));
    config.proxy.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config));
    await service.reconcileRuntime();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("holds managed readiness until enrollment settles and discovery succeeds", async () => {
    let tick;
    let stop = () => {};
    try {
      const openclawDir = path.join(rootDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          gateway: { mode: "local" },
          proxy: { enabled: true },
        }),
      );
      const {
        writeAgentVaultRuntime,
      } = require("../../lib/server/agent-vault/runtime-store");
      writeAgentVaultRuntime({
        token: "av_runtime_token_123456789",
        vault: "default",
        mode: "brokered",
        operatorUrl: "https://vault.tail123.ts.net",
        tokenAcknowledged: true,
        handoffComplete: true,
      });
      const {
        createAgentVaultService,
      } = require("../../lib/server/agent-vault/service");
      const fetchImpl = vi.fn(async () =>
        Response.json({ services: [], available_credentials: [] }),
      );
      let releaseRestart;
      let notifyRestart;
      const restartStarted = new Promise((resolve) => {
        notifyRestart = resolve;
      });
      const service = createAgentVaultService({
        env: { ALPHACLAW_CONNECTIVITY_MODE: "security_gateway" },
        openclawDir,
        fetchImpl,
        onRuntimeRestartRequired: () =>
          new Promise((resolve) => {
            releaseRestart = resolve;
            notifyRestart();
          }),
      });
      expect(await service.isRuntimeReady()).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      stop = service.startRuntimeClaimPolling({
        setTimeoutFn: (callback) => {
          tick = callback;
          return { unref() {} };
        },
        clearTimeoutFn: () => {},
      });
      await tick();
      expect(await service.isRuntimeReady()).toBe(true);
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          gateway: { mode: "local" },
          proxy: { enabled: false },
        }),
      );
      const restarting = tick();
      await restartStarted;
      expect(await service.isRuntimeReady()).toBe(false);
      releaseRestart();
      await restarting;
      expect(await service.isRuntimeReady()).toBe(true);
      fetchImpl.mockRejectedValueOnce(new Error("Vault unavailable"));
      expect(await service.isRuntimeReady()).toBe(false);
      expect(await service.isRuntimeReady()).toBe(true);
      // A known runtime token alone is insufficient: its handoff must finish.
      writeAgentVaultRuntime({
        token: "av_runtime_token_123456789",
        vault: "default",
        mode: "brokered",
        operatorUrl: "https://vault.tail123.ts.net",
        tokenAcknowledged: false,
        handoffComplete: false,
      });
      expect(await service.isRuntimeReady()).toBe(false);
      const local = createAgentVaultService({
        env: {},
        openclawDir,
        fetchImpl,
      });
      expect(await local.isRuntimeReady()).toBe(true);
    } finally {
      stop();
    }
  });
});
