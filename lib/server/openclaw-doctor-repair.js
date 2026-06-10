const { execSync } = require("child_process");

const kDefaultDoctorRepairTimeoutMs = 120 * 1000;

const runOpenclawDoctorRepairSync = ({
  env = process.env,
  execSyncImpl = execSync,
  logger = console,
  reason = "config_read_failed",
  timeoutMs = kDefaultDoctorRepairTimeoutMs,
} = {}) => {
  logger.warn?.(
    `[alphaclaw] Delegating OpenClaw config repair to doctor --fix --yes (${reason})`,
  );
  try {
    const stdout = execSyncImpl("openclaw doctor --fix --yes", {
      env,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const details = String(stdout || "").trim();
    if (details) {
      logger.log?.(`[alphaclaw] OpenClaw doctor repair completed: ${details.slice(0, 300)}`);
    } else {
      logger.log?.("[alphaclaw] OpenClaw doctor repair completed");
    }
    return { ok: true, stdout: details };
  } catch (error) {
    const details = String(error?.stderr || error?.stdout || error?.message || "").trim();
    logger.error?.(
      `[alphaclaw] OpenClaw doctor repair failed: ${details.slice(0, 500)}`,
    );
    return {
      ok: false,
      error: details || "openclaw doctor --fix --yes failed",
      code: error?.status ?? error?.code ?? null,
    };
  }
};

module.exports = {
  kDefaultDoctorRepairTimeoutMs,
  runOpenclawDoctorRepairSync,
};
