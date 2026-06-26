const {
  kGuardedOpenclawDoctorRepairCommand,
  runOpenclawDoctorRepairSync,
} = require("../../lib/server/openclaw-doctor-repair");

describe("server/openclaw-doctor-repair", () => {
  it("runs startup config repair through guarded noninteractive doctor", () => {
    const execSyncImpl = vi.fn(() => "fixed\n");
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };

    const result = runOpenclawDoctorRepairSync({
      env: {
        OPENCLAW_HOME: "/tmp/alphaclaw",
        OPENCLAW_CONFIG_PATH: "/tmp/alphaclaw/.openclaw/openclaw.json",
      },
      execSyncImpl,
      logger,
      reason: "test",
      timeoutMs: 1234,
    });

    expect(result).toEqual({ ok: true, stdout: "fixed" });
    expect(execSyncImpl).toHaveBeenCalledWith(kGuardedOpenclawDoctorRepairCommand, {
      env: expect.objectContaining({
        OPENCLAW_HOME: "/tmp/alphaclaw",
        OPENCLAW_CONFIG_PATH: "/tmp/alphaclaw/.openclaw/openclaw.json",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      }),
      timeout: 1234,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(execSyncImpl.mock.calls[0][0]).not.toContain("--yes");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("guarded doctor --non-interactive --fix"),
    );
  });

  it("returns a clear failure when guarded doctor fails", () => {
    const error = new Error("boom");
    error.status = 7;
    error.stderr = "doctor failed";
    const execSyncImpl = vi.fn(() => {
      throw error;
    });
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };

    const result = runOpenclawDoctorRepairSync({
      execSyncImpl,
      logger,
    });

    expect(result).toEqual({
      ok: false,
      error: "doctor failed",
      code: 7,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw doctor repair failed"),
    );
  });
});
