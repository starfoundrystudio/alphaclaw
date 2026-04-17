const { initializeServerRuntime } = require("../../lib/server/init/runtime-init");

describe("server/init/runtime-init", () => {
  const createDeps = ({
    onboarded = false,
    hasConfig = false,
  } = {}) => {
    const constants = {
      OPENCLAW_DIR: "/tmp/openclaw",
      kOnboardingMarkerPath: "/tmp/alphaclaw/onboarded.json",
      kRootDir: "/tmp/alphaclaw",
      kWebhookPruneDays: 30,
      kWatchdogLogRetentionDays: 30,
    };
    const fs = {
      existsSync: vi.fn((targetPath) => {
        if (onboarded && targetPath === constants.kOnboardingMarkerPath) return true;
        if (hasConfig && targetPath === "/tmp/openclaw/openclaw.json") return true;
        return false;
      }),
    };
    return {
      fs,
      constants,
      startEnvWatcher: vi.fn(),
      attachGatewaySignalHandlers: vi.fn(),
      cleanupStaleImportTempDirs: vi.fn(),
      migrateManagedInternalFiles: vi.fn(),
    };
  };

  it("skips managed runtime migration before onboarding when no config exists", () => {
    const deps = createDeps();

    initializeServerRuntime(deps);

    expect(deps.startEnvWatcher).toHaveBeenCalledTimes(1);
    expect(deps.attachGatewaySignalHandlers).toHaveBeenCalledTimes(1);
    expect(deps.cleanupStaleImportTempDirs).toHaveBeenCalledTimes(1);
    expect(deps.migrateManagedInternalFiles).not.toHaveBeenCalled();
  });

  it("runs managed runtime migration after onboarding", () => {
    const deps = createDeps({ onboarded: true });

    initializeServerRuntime(deps);

    expect(deps.migrateManagedInternalFiles).toHaveBeenCalledWith({
      fs: deps.fs,
      openclawDir: deps.constants.OPENCLAW_DIR,
    });
  });

  it("runs managed runtime migration when a real openclaw config already exists", () => {
    const deps = createDeps({ hasConfig: true });

    initializeServerRuntime(deps);

    expect(deps.migrateManagedInternalFiles).toHaveBeenCalledWith({
      fs: deps.fs,
      openclawDir: deps.constants.OPENCLAW_DIR,
    });
  });
});
