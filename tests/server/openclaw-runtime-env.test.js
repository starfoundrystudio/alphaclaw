const path = require("path");
const { kRootDir } = require("../../lib/server/constants");
const {
  ensureOpenclawStartupEnv,
  resolveManagedCodexHome,
  withManagedOpenclawEnv,
  withOpenclawMaintenanceEnv,
  withOpenclawStartupEnv,
} = require("../../lib/server/openclaw-runtime-env");

describe("server/openclaw-runtime-env", () => {
  it("defaults OpenClaw CLI startup settings to the stable AlphaClaw root", () => {
    const env = withOpenclawStartupEnv({ FOO: "bar" });

    expect(env).toEqual(
      expect.objectContaining({
        FOO: "bar",
        NODE_COMPILE_CACHE: path.join(
          kRootDir,
          "cache",
          "openclaw-compile-cache",
        ),
        OPENCLAW_NO_RESPAWN: "1",
      }),
    );
  });

  it("preserves explicit OpenClaw startup settings", () => {
    const env = withOpenclawStartupEnv({
      NODE_COMPILE_CACHE: "/custom/cache",
      OPENCLAW_NO_RESPAWN: "0",
    });

    expect(env.NODE_COMPILE_CACHE).toBe("/custom/cache");
    expect(env.OPENCLAW_NO_RESPAWN).toBe("0");
  });

  it("enforces managed supervision, config ownership, and update refusal", () => {
    const env = withManagedOpenclawEnv({
      OPENCLAW_SUPERVISOR_MODE: "systemd",
      OPENCLAW_CONFIG_READONLY: "0",
      OPENCLAW_NO_AUTO_UPDATE: "0",
    });

    expect(env).toEqual(expect.objectContaining({
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_CONFIG_READONLY: "1",
      OPENCLAW_DISABLE_UPDATE_CHECK: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
    }));
  });

  it("keeps lifecycle ownership while allowing Clawbridge maintenance writes", () => {
    const env = withOpenclawMaintenanceEnv({ OPENCLAW_CONFIG_READONLY: "1" });

    expect(env.OPENCLAW_CONFIG_READONLY).toBeUndefined();
    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
    expect(env.OPENCLAW_NO_AUTO_UPDATE).toBe("1");
  });

  it("preserves the legacy managed Codex home for upgraded instances", () => {
    const fsModule = { existsSync: vi.fn(() => true) };

    expect(
      resolveManagedCodexHome({
        rootDir: "/managed",
        env: { HOME: "/service" },
        fsModule,
      }),
    ).toBe("/managed/.codex");
    expect(fsModule.existsSync).toHaveBeenCalledWith("/managed/.codex");
  });

  it("uses the service Codex home for fresh instances", () => {
    expect(
      resolveManagedCodexHome({
        rootDir: "/managed",
        env: { HOME: "/service" },
        fsModule: { existsSync: () => false },
      }),
    ).toBe("/service/.codex");
  });

  it("creates the compile cache directory and backfills missing process env values", () => {
    const fsModule = { mkdirSync: vi.fn() };
    const logger = { warn: vi.fn() };
    const env = {};

    const result = ensureOpenclawStartupEnv({ fsModule, env, logger });

    expect(fsModule.mkdirSync).toHaveBeenCalledWith(result.NODE_COMPILE_CACHE, {
      recursive: true,
    });
    expect(env.NODE_COMPILE_CACHE).toBe(result.NODE_COMPILE_CACHE);
    expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
