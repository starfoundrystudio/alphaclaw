const path = require("path");

const kTailnetManagerRequestPath =
  "/run/alphaclaw-tailnet-manager/request.json";
const kTailnetManagerStateDir = "/var/lib/alphaclaw-tailnet-manager";
const kTailnetManagerCapabilityPath = path.join(
  kTailnetManagerStateDir,
  "capability.json",
);
const kTailnetManagerStatusPath = path.join(
  kTailnetManagerStateDir,
  "status.json",
);
const kTailnetManagerRequestVersion = 2;
const kTailnetManagerFailureStates = new Set([
  "failed",
  "rolled_back",
  "rollback_failed",
]);
const kTailnetManagerAcknowledgedStates = new Set([
  "queued",
  "switching",
  "verifying",
  "configuring_exposure",
  "completed",
]);

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

const isMissingManagerFile = (error) =>
  ["ENOENT", "EACCES", "EPERM"].includes(String(error?.code || ""));

const createUnavailableCapability = () => ({
  ok: false,
  available: false,
  compatible: false,
  requestVersion: 0,
  error: "Change Tailnet requires a clawctl host upgrade before it can run.",
});

const createTailnetHostManager = ({
  fs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  scheduleAckAttempts = 100,
  scheduleAckIntervalMs = 100,
} = {}) => {
  if (!fs) throw new Error("Tailnet manager requires filesystem support");

  const readJsonFile = (filePath, operation) =>
    parseManagerJson(fs.readFileSync(filePath, "utf8"), operation);

  const check = async () => {
    let result;
    try {
      result = readJsonFile(kTailnetManagerCapabilityPath, "capability");
    } catch (error) {
      if (isMissingManagerFile(error)) return createUnavailableCapability();
      return {
        ...createUnavailableCapability(),
        error: "Change Tailnet host capability could not be verified.",
      };
    }

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

  const getStatus = async () => {
    try {
      return readJsonFile(kTailnetManagerStatusPath, "status");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          ok: true,
          version: kTailnetManagerRequestVersion,
          operationId: null,
          state: "idle",
          startedAt: null,
          completedAt: null,
          dnsName: null,
          error: null,
          rolledBack: false,
        };
      }
      throw new Error("Tailnet manager status could not be read");
    }
  };

  const waitForScheduleAcknowledgement = async (operationId) => {
    for (let attempt = 0; attempt < scheduleAckAttempts; attempt += 1) {
      const status = await getStatus();
      if (status?.operationId === operationId) {
        if (kTailnetManagerFailureStates.has(String(status.state || ""))) {
          throw new Error(
            String(status.error || "Tailnet manager rejected the request"),
          );
        }
        if (kTailnetManagerAcknowledgedStates.has(String(status.state || ""))) {
          return status;
        }
      }
      await sleep(scheduleAckIntervalMs);
    }
    throw new Error(
      "Tailnet manager dispatcher did not acknowledge the request",
    );
  };

  const removeUnconsumedRequest = (operationId) => {
    try {
      const staged = readJsonFile(kTailnetManagerRequestPath, "request");
      if (staged?.operationId === operationId) {
        fs.rmSync(kTailnetManagerRequestPath, { force: true });
      }
    } catch {}
  };

  const stageAndSchedule = async (request) => {
    const capability = await check();
    if (!capability.ok) {
      const error = new Error(
        capability.error || "Tailnet manager is not available on this host",
      );
      error.status = 503;
      throw error;
    }

    const tempPath = `${kTailnetManagerRequestPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(request)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tempPath, kTailnetManagerRequestPath);
      return await waitForScheduleAcknowledgement(request.operationId);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      removeUnconsumedRequest(request.operationId);
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
  kTailnetManagerRequestPath,
  kTailnetManagerCapabilityPath,
  kTailnetManagerStatusPath,
  kTailnetManagerRequestVersion,
  parseManagerJson,
  createTailnetHostManager,
};
