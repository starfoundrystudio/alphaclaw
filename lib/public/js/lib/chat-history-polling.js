// Server-started greetings and recovered runs are not owned by the browser's
// streaming connection. Keep reading their history until OpenClaw marks them idle.
export const shouldPollChatHistory = ({
  messages = [],
  rawHistory = null,
  sessionKey = "",
  browserRunSessionKey = "",
  sending = false,
  streaming = false,
  needsReconciliation = false,
} = {}) =>
  !(
    sessionKey &&
    sessionKey === browserRunSessionKey &&
    (sending || streaming)
  ) &&
  (needsReconciliation ||
    messages.length === 0 ||
    rawHistory?.sessionInfo?.hasActiveRun === true);

// Two overlapping requests can both read before completion and report idle
// afterward. Only a request issued after the first idle response confirms it.
export const createChatHistoryPollTracker = () => {
  let nextRequestId = 0;
  const sessions = new Map();
  const getSession = (key) => {
    if (!sessions.has(key))
      sessions.set(key, {
        issued: 0,
        received: 0,
        idleAfter: null,
        needsPoll: true,
        cycleStart: 0,
      });
    return sessions.get(key);
  };
  return {
    startCycle(key) {
      const state = getSession(key);
      state.idleAfter = null;
      state.needsPoll = true;
      state.cycleStart = nextRequestId + 1;
    },
    beginRequest(key, { reconcile = false } = {}) {
      if (reconcile) this.startCycle(key);
      const state = getSession(key);
      state.issued = ++nextRequestId;
      return state.issued;
    },
    acceptsResponse(key, requestId) {
      const state = getSession(key);
      return Number.isSafeInteger(requestId) &&
        requestId > state.received && requestId >= state.cycleStart;
    },
    observeResponse(key, requestId, { messages = [], rawHistory } = {}) {
      const state = getSession(key);
      if (!this.acceptsResponse(key, requestId)) {
        return state.needsPoll;
      }
      state.received = requestId;
      if (
        messages.length === 0 ||
        rawHistory?.sessionInfo?.hasActiveRun === true
      ) {
        state.idleAfter = null;
        state.needsPoll = true;
      } else if (!state.needsPoll) {
        // Late or overlapping idle snapshots cannot reopen a completed cycle.
        return false;
      } else if (state.idleAfter !== null && requestId > state.idleAfter) {
        state.needsPoll = false;
      } else {
        state.idleAfter ??= state.issued;
        state.needsPoll = true;
      }
      return state.needsPoll;
    },
  };
};
