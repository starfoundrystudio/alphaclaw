const path = require("path");
const { Worker } = require("worker_threads");
const { computeWorkspaceSnapshot } = require("./workspace-fingerprint");

const kDefaultSnapshotCacheTtlMs = 5000;

const runSnapshotWorker = ({ workspaceRoot, workerPath }) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { workspaceRoot },
    });
    let settled = false;

    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    worker.once("message", (message) => {
      if (message?.ok) {
        settle(resolve, message.snapshot);
        return;
      }
      const error = new Error(message?.error || "Workspace snapshot failed");
      if (message?.stack) error.stack = message.stack;
      settle(reject, error);
    });
    worker.once("error", (error) => settle(reject, error));
    worker.once("exit", (code) => {
      if (code === 0) return;
      settle(reject, new Error(`Workspace snapshot worker exited with code ${code}`));
    });
    if (typeof worker.unref === "function") worker.unref();
  });

const createWorkspaceSnapshotManager = ({
  workspaceRoot,
  cacheTtlMs = kDefaultSnapshotCacheTtlMs,
  useWorker = true,
  workerPath = path.join(__dirname, "workspace-snapshot-worker.js"),
  computeSnapshot = computeWorkspaceSnapshot,
} = {}) => {
  const state = {
    snapshot: null,
    computedAt: 0,
    refreshPromise: null,
    refreshIsForced: false,
    refreshStartedAt: 0,
    queuedForcedRefreshPromise: null,
    lastError: null,
  };

  const isSnapshotFresh = () =>
    !!state.snapshot && Date.now() - state.computedAt < cacheTtlMs;

  const compute = () => {
    if (useWorker) return runSnapshotWorker({ workspaceRoot, workerPath });
    return Promise.resolve().then(() => computeSnapshot(workspaceRoot));
  };

  const startRefresh = ({ force = false } = {}) => {
    state.refreshStartedAt = Date.now();
    state.refreshIsForced = !!force;
    state.refreshPromise = compute()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.computedAt = Date.now();
        state.lastError = null;
        return snapshot;
      })
      .catch((error) => {
        state.lastError = {
          message: error?.message || "Workspace snapshot failed",
          at: new Date().toISOString(),
        };
        throw error;
      })
      .finally(() => {
        state.refreshPromise = null;
        state.refreshIsForced = false;
        state.refreshStartedAt = 0;
      });

    return state.refreshPromise;
  };

  const queueForcedRefresh = () => {
    if (state.queuedForcedRefreshPromise) return state.queuedForcedRefreshPromise;
    const currentRefresh = state.refreshPromise;
    state.queuedForcedRefreshPromise = Promise.resolve(currentRefresh)
      .catch(() => {})
      .then(() => startRefresh({ force: true }))
      .finally(() => {
        state.queuedForcedRefreshPromise = null;
      });
    return state.queuedForcedRefreshPromise;
  };

  const refresh = ({ force = false } = {}) => {
    if (!force && isSnapshotFresh()) return Promise.resolve(state.snapshot);
    if (state.refreshPromise) {
      if (force && !state.refreshIsForced) return queueForcedRefresh();
      return state.refreshPromise;
    }
    if (state.queuedForcedRefreshPromise) {
      return state.queuedForcedRefreshPromise;
    }

    return startRefresh({ force });
  };

  const triggerRefresh = ({ force = false } = {}) => {
    if (!force && isSnapshotFresh()) return;
    if (state.refreshPromise) {
      if (force && !state.refreshIsForced) {
        queueForcedRefresh().catch(() => {});
      }
      return;
    }
    refresh({ force }).catch(() => {});
  };

  const getSnapshot = () => state.snapshot;

  const getStatus = () => ({
    refreshing: !!(state.refreshPromise || state.queuedForcedRefreshPromise),
    computedAt: state.computedAt ? new Date(state.computedAt).toISOString() : null,
    refreshStartedAt: state.refreshStartedAt
      ? new Date(state.refreshStartedAt).toISOString()
      : null,
    lastError: state.lastError,
  });

  return {
    getSnapshot,
    getStatus,
    refresh,
    triggerRefresh,
  };
};

module.exports = {
  createWorkspaceSnapshotManager,
  kDefaultSnapshotCacheTtlMs,
};
