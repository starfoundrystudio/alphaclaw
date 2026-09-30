import {
  fetchOnboardStatus,
  runOnboard,
  subscribeOperationEvents,
} from "../../lib/api.js";

// Setup completion runs on the server as a background operation. The POST
// answers with an operation id; progress and the result arrive on the
// operation's event stream. When the stream drops (network blip, or the
// service restart that follows a successful setup), the onboarding status
// endpoint decides: onboarded means success, a still-running operation means
// re-attach, anything else means the setup was interrupted.
export const kOnboardStatusPollAttempts = 90;
export const kOnboardStatusPollIntervalMs = 2000;
const kMaxStreamAttachments = 6;

const defaultWait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// One subscription: resolves { type: "done" | "error" | "disconnected" }.
export const streamOnboardOperationOnce = ({
  operationId,
  onProgress = () => {},
  subscribe = subscribeOperationEvents,
}) =>
  new Promise((resolve) => {
    let settled = false;
    let close = () => {};
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        close();
      } catch {}
      resolve(outcome);
    };
    try {
      close = subscribe({
        operationId,
        onMessage: (entry = {}) => {
          const eventName = String(entry.event || "");
          const data = entry.data || {};
          if (eventName === "phase") {
            const label = String(data.label || "").trim();
            if (label) onProgress(label);
            return;
          }
          if (eventName === "done") {
            settle({ type: "done", data });
            return;
          }
          if (eventName === "error") {
            // EventSource reports connection failures as "error" events
            // too; only a server-sent error carries a message.
            const message = String(data.error || "").trim();
            settle(
              message
                ? { type: "error", error: message }
                : { type: "disconnected" },
            );
          }
        },
        onError: () => settle({ type: "disconnected" }),
      });
      if (settled) {
        try {
          close();
        } catch {}
      }
    } catch {
      settle({ type: "disconnected" });
    }
  });

// Polls status through a restart window (the server is unreachable while the
// service swaps). Returns the first readable status, or null when the server
// never answered.
export const readOnboardStatusAfterDisconnect = async ({
  fetchStatus = fetchOnboardStatus,
  wait = defaultWait,
  attempts = kOnboardStatusPollAttempts,
  intervalMs = kOnboardStatusPollIntervalMs,
} = {}) => {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const status = await fetchStatus();
      if (status && typeof status === "object") return status;
    } catch {}
    if (attempt < maxAttempts - 1) await wait(intervalMs);
  }
  return null;
};

export const followOnboardOperation = async ({
  operationId,
  onProgress = () => {},
  subscribe = subscribeOperationEvents,
  fetchStatus = fetchOnboardStatus,
  wait = defaultWait,
  statusPollAttempts = kOnboardStatusPollAttempts,
  statusPollIntervalMs = kOnboardStatusPollIntervalMs,
  maxAttachments = kMaxStreamAttachments,
}) => {
  const normalizedId = String(operationId || "").trim();
  if (!normalizedId) throw new Error("Setup did not start");
  for (let attachment = 0; attachment < maxAttachments; attachment += 1) {
    const outcome = await streamOnboardOperationOnce({
      operationId: normalizedId,
      onProgress,
      subscribe,
    });
    if (outcome.type === "done") {
      if (outcome.data?.ok === false) {
        throw new Error(outcome.data.error || "Onboarding failed");
      }
      return outcome.data;
    }
    if (outcome.type === "error") throw new Error(outcome.error);
    const status = await readOnboardStatusAfterDisconnect({
      fetchStatus,
      wait,
      attempts: statusPollAttempts,
      intervalMs: statusPollIntervalMs,
    });
    if (status?.onboarded === true) return status;
    // A running operation re-attaches; a settled one replays its final
    // event on the next subscription while this process still holds it.
    if (!status) break;
    if (
      !status.onboardingOperation?.operationId &&
      attachment >= 1
    ) {
      break;
    }
    await wait(statusPollIntervalMs);
  }
  throw new Error("Setup was interrupted before it finished. Please retry.");
};

// Starts setup and follows it to the final result body.
export const startAndFollowOnboard = async ({
  vars,
  modelKey,
  agentRuntimeId = null,
  tailscaleApiToken = "",
  onProgress = () => {},
  start = runOnboard,
  follow = followOnboardOperation,
}) => {
  const started = await start(vars, modelKey, {
    agentRuntimeId,
    tailscaleApiToken,
  });
  if (!started?.ok) throw new Error(started?.error || "Onboarding failed");
  const operationId = String(started.operationId || "").trim();
  // A server without background setup answers with the final result.
  if (!operationId) return started;
  return follow({ operationId, onProgress });
};
