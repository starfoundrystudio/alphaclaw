const path = require("path");

const kTailnetManagerPath = "/usr/local/sbin/alphaclaw-tailnet-manager";
const kTailnetManagerRequestPath =
  "/run/alphaclaw-tailnet-manager/request.json";
const kTailnetManagerRequestVersion = 2;
const kTailnetManagerOperations = new Set(["check", "schedule", "status"]);

const parseManagerJson = (raw, operation) => {
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Tailnet manager ${operation} returned invalid JSON: ${error.message}`,
    );
  }
};

const getManagerErrorText = (error) =>
  [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");

const isManagerUnavailableError = (error) => {
  const text = getManagerErrorText(error).toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("permission denied") ||
    text.includes("not in the sudoers") ||
    text.includes("a password is required") ||
    text.includes("sudo: a terminal is required")
  );
};

const createTailnetHostManager = ({ shellCmd, fs } = {}) => {
  if (typeof shellCmd !== "function") {
    throw new Error("Tailnet manager requires shell command support");
  }
  if (!fs) throw new Error("Tailnet manager requires filesystem support");

  const run = async (operation, { required = true } = {}) => {
    if (!kTailnetManagerOperations.has(operation)) {
      throw new Error(`Unsupported tailnet manager operation: ${operation}`);
    }
    try {
      const raw = await shellCmd(
        `sudo -n ${kTailnetManagerPath} ${operation}`,
        { timeoutMs: 30000, logStdout: false },
      );
      return parseManagerJson(raw, operation);
    } catch (error) {
      if (!required && isManagerUnavailableError(error)) {
        return {
          ok: false,
          available: false,
          error:
            "Change Tailnet requires a clawctl host upgrade before it can run.",
        };
      }
      throw error;
    }
  };

  const check = async ({ required = false } = {}) => {
    const result = await run("check", { required });
    const requestVersion = Number(result?.requestVersion || 0);
    const available = result?.ok === true;
    const compatible =
      available && requestVersion >= kTailnetManagerRequestVersion;
    return {
      ...result,
      ok: compatible,
      available,
      compatible,
      requestVersion,
      ...(!compatible && available
        ? {
            error:
              "Change Tailnet requires a clawctl host upgrade with tailnet-manager protocol version 2.",
          }
        : {}),
    };
  };

  const getStatus = () => run("status");

  const stageAndSchedule = async (request) => {
    const capability = await check({ required: true });
    if (!capability.ok) {
      const error = new Error(
        capability.error || "Tailnet manager is not available on this host",
      );
      error.status = 503;
      throw error;
    }

    const requestDir = path.dirname(kTailnetManagerRequestPath);
    fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    const tempPath = `${kTailnetManagerRequestPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(request)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tempPath, kTailnetManagerRequestPath);
      return await run("schedule");
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      try {
        fs.rmSync(kTailnetManagerRequestPath, { force: true });
      } catch {}
      throw error;
    }
  };

  return {
    check,
    getStatus,
    stageAndSchedule,
  };
};

module.exports = {
  kTailnetManagerPath,
  kTailnetManagerRequestPath,
  kTailnetManagerRequestVersion,
  parseManagerJson,
  isManagerUnavailableError,
  createTailnetHostManager,
};
