const { runOnboardedBootSequence } = require("../../lib/server/startup");

describe("server/startup", () => {
  it("syncs gateway proxy config with the resolved setup URL before startup", async () => {
    const callOrder = [];
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const syncChannelConfig = vi.fn(() => callOrder.push("syncChannelConfig"));
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() =>
      callOrder.push("ensureManagedGatewayDevice"),
    );
    const startGateway = vi.fn(async () => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    expect(reloadEnv).toHaveBeenCalledWith({ clearMissing: false });
    expect(syncChannelConfig).not.toHaveBeenCalled();
    expect(ensureGatewayProxyConfig).toHaveBeenCalledWith("https://setup.example.com");
    expect(callOrder).toEqual([
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "doSyncPromptFiles",
      "reloadEnv",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "ensureManagedGatewayDevice",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
  });

  it("waits for gateway startup before starting watchdog services", async () => {
    const callOrder = [];
    let resolveStartGateway;
    const startGatewayReady = new Promise((resolve) => {
      resolveStartGateway = resolve;
    });
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() =>
      callOrder.push("ensureManagedGatewayDevice"),
    );
    const startGateway = vi.fn(async () => {
      callOrder.push("startGateway:start");
      await startGatewayReady;
      callOrder.push("startGateway:done");
    });
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    const bootPromise = runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    await Promise.resolve();

    expect(callOrder).toContain("ensureManagedGatewayDevice");
    expect(callOrder).toContain("startGateway:start");
    expect(watchdog.start).not.toHaveBeenCalled();
    expect(gmailWatchService.start).not.toHaveBeenCalled();

    resolveStartGateway();
    await bootPromise;

    expect(callOrder.slice(-3)).toEqual([
      "startGateway:done",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
  });

  it("starts the TeamYou memory activation watcher after gateway startup", async () => {
    const callOrder = [];
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() =>
      callOrder.push("ensureManagedGatewayDevice"),
    );
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const startGateway = vi.fn(async () => callOrder.push("startGateway"));
    const teamyouMemoryActivation = {
      start: vi.fn(() => callOrder.push("teamyouMemoryActivation.start")),
    };
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      teamyouMemoryActivation,
      watchdog,
      gmailWatchService,
    });

    expect(callOrder.slice(-4)).toEqual([
      "startGateway",
      "teamyouMemoryActivation.start",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
  });

  it("delegates invalid config repair to doctor before retrying config boot steps", async () => {
    const callOrder = [];
    const configError = new Error("Could not read valid openclaw.json: bad json");
    configError.name = "OpenclawConfigReadError";
    const ensureManagedExecDefaults = vi
      .fn()
      .mockImplementationOnce(() => {
        callOrder.push("ensureManagedExecDefaults:error");
        throw configError;
      })
      .mockImplementationOnce(() => callOrder.push("ensureManagedExecDefaults:retry"));
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() =>
      callOrder.push("ensureManagedGatewayDevice"),
    );
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const startGateway = vi.fn(async () => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };
    const runOpenclawDoctorRepair = vi.fn(() => {
      callOrder.push("doctor");
      return { ok: true };
    });

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
      runOpenclawDoctorRepair,
    });

    expect(runOpenclawDoctorRepair).toHaveBeenCalledWith({
      reason: "failed_to_ensure_managed_exec_defaults_on_boot",
    });
    expect(callOrder).toEqual([
      "ensureManagedExecDefaults:error",
      "doctor",
      "ensureManagedExecDefaults:retry",
      "ensureUsageTrackerPluginConfig",
      "doSyncPromptFiles",
      "reloadEnv",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "ensureManagedGatewayDevice",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
  });

  it("continues booting when managed gateway device approval repair fails", async () => {
    const callOrder = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() => {
      callOrder.push("ensureManagedGatewayDevice");
      return { ok: false, error: "approval failed" };
    });
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const startGateway = vi.fn(async () => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Managed gateway device approval check failed: approval failed",
    );
    expect(callOrder).toEqual([
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "doSyncPromptFiles",
      "reloadEnv",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "ensureManagedGatewayDevice",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
    consoleErrorSpy.mockRestore();
  });

  it("logs managed gateway device approval readiness on boot", async () => {
    const callOrder = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const ensureManagedGatewayDevice = vi.fn(() => {
      callOrder.push("ensureManagedGatewayDevice");
      return {
        ok: true,
        reason: "repaired",
        deviceId: "1234567890abcdef",
        scopes: ["operator.approvals", "operator.read"],
      };
    });
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const startGateway = vi.fn(async () => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[alphaclaw] Managed gateway device approval ready reason=repaired device=1234567890ab scopes=operator.approvals,operator.read",
    );
    consoleLogSpy.mockRestore();
  });
});
