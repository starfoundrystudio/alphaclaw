const path = require("path");

const kTerminalStates = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "rolled_back",
  "rollback_failed",
]);

const sanitizeState = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  return {
    version: 1,
    operationId: String(source.operationId || "").trim(),
    state: String(source.state || "idle").trim() || "idle",
    currentDns: String(source.currentDns || "").trim(),
    previousSetupUrl: String(source.previousSetupUrl || "").trim(),
    previousPublicBaseUrl: String(source.previousPublicBaseUrl || "").trim(),
    expectedDnsSuffix: String(source.expectedDnsSuffix || "").trim(),
    expectedSetupUrl: String(source.expectedSetupUrl || "").trim(),
    expectedPublicBaseUrl: String(source.expectedPublicBaseUrl || "").trim(),
    dnsName: String(source.dnsName || "").trim(),
    setupUrl: String(source.setupUrl || "").trim(),
    publicBaseUrl: String(source.publicBaseUrl || "").trim(),
    error: String(source.error || "").trim(),
    warnings,
    startedAt: String(source.startedAt || "").trim(),
    completedAt: String(source.completedAt || "").trim(),
    updatedAt: String(source.updatedAt || "").trim(),
  };
};

const createTailnetChangeStore = ({ fs, statePath } = {}) => {
  if (!fs) throw new Error("Tailnet change store requires filesystem support");
  if (!statePath) throw new Error("Tailnet change store requires a state path");

  const read = () => {
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(statePath, "utf8")));
    } catch {
      return sanitizeState();
    }
  };

  const write = (state) => {
    const next = sanitizeState({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, statePath);
    return next;
  };

  const update = (patch) => write({ ...read(), ...(patch || {}) });
  const isActive = () => {
    const state = read().state;
    return state !== "idle" && !kTerminalStates.has(state);
  };

  return { read, write, update, isActive };
};

module.exports = {
  kTerminalStates,
  sanitizeState,
  createTailnetChangeStore,
};
