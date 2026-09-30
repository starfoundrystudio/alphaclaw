// Setup completion runs as a background operation: the POST validates and
// returns an operation id at once, progress and the final result travel over
// the shared operation-events stream (/api/operations/:id/events). This keeps
// the browser request well under proxy read timeouts (Cloudflare answers 524
// after 125 s without response bytes) and lets a reloaded page re-attach.
const kHostFinalizationDelayMs = 1500;
const kOnboardingOperationType = "onboarding";

const createOnboardingOperationRunner = ({
  operationEvents,
  sanitizeError = (error) => String(error?.message || error || "Setup failed"),
  logError = () => {},
  // Host finalization restarts this service. Give the final SSE event time
  // to flush to the browser before that happens.
  hostFinalizationDelayMs = kHostFinalizationDelayMs,
  setTimeoutImpl = setTimeout,
} = {}) => {
  let active = null;

  const getActiveOperationId = () => active?.operationId || "";

  const publishProgress = (operationId, { phase = "", label = "" } = {}) => {
    operationEvents.publish(operationId, {
      event: "phase",
      data: {
        phase: String(phase || "").trim(),
        label: String(label || "").trim(),
      },
    });
  };

  // `run` receives { onProgress } and resolves to { body, afterComplete }.
  // While an operation is running, every start returns the same id.
  const start = ({ run }) => {
    if (active) {
      return { operationId: active.operationId, reused: true, promise: active.promise };
    }
    const { operationId } = operationEvents.createOperation({
      type: kOnboardingOperationType,
    });
    const current = { operationId, promise: null };
    active = current;
    current.promise = (async () => {
      let result;
      try {
        result = await run({
          onProgress: (progress) => publishProgress(operationId, progress),
        });
      } catch (error) {
        logError(error);
        if (active === current) active = null;
        operationEvents.fail(operationId, new Error(sanitizeError(error)));
        return;
      }
      if (active === current) active = null;
      operationEvents.complete(operationId, result?.body || { ok: true });
      if (typeof result?.afterComplete === "function") {
        setTimeoutImpl(() => {
          try {
            result.afterComplete();
          } catch (error) {
            logError(error);
          }
        }, hostFinalizationDelayMs);
      }
    })();
    return { operationId, reused: false, promise: current.promise };
  };

  return { start, getActiveOperationId };
};

module.exports = {
  createOnboardingOperationRunner,
  kHostFinalizationDelayMs,
  kOnboardingOperationType,
};
