const { parentPort, workerData } = require("worker_threads");
const { computeWorkspaceSnapshot } = require("./workspace-fingerprint");

try {
  const snapshot = computeWorkspaceSnapshot(workerData?.workspaceRoot || "");
  parentPort.postMessage({ ok: true, snapshot });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.message || "Workspace snapshot failed",
    stack: error?.stack || "",
  });
}
