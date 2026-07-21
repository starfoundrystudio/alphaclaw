const path = require("path");
const { parseJsonSafe } = require("./utils/json");

const kComposioStateVersion = 1;

// Toolkit slugs Composio uses for Google Workspace services.
const kGoogleWorkspaceToolkits = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googledocs",
  "googlesheets",
  "googletasks",
  "googlemeet",
];

const composioStatePath = (openclawDir) =>
  path.join(openclawDir, "composio", "state.json");

const createEmptyComposioState = () => ({
  version: kComposioStateVersion,
  cliInstalled: false,
  loggedIn: false,
  accounts: [],
  refreshedAt: null,
  lastError: "",
});

const normalizeComposioAccount = (entry = {}) => {
  if (!entry || typeof entry !== "object") return null;
  const toolkit = String(
    entry.toolkit?.slug ||
      entry.toolkit ||
      entry.appName ||
      entry.app_name ||
      entry.app ||
      "",
  )
    .trim()
    .toLowerCase();
  const id = String(
    entry.id ||
      entry.connectedAccountId ||
      entry.connected_account_id ||
      entry.nanoid ||
      "",
  ).trim();
  if (!toolkit && !id) return null;
  const status = String(entry.status || "").trim().toUpperCase();
  return {
    id,
    toolkit,
    status,
    active: !status || status === "ACTIVE" || status === "CONNECTED",
    // Best-effort human label; Composio surfaces vary by version. `label`
    // first so already-normalized entries survive re-normalization.
    label: String(
      entry.label ||
        entry.userId ||
        entry.user_id ||
        entry.entityId ||
        entry.entity_id ||
        entry.email ||
        "",
    ).trim(),
  };
};

const normalizeComposioState = (state = {}) => ({
  version: kComposioStateVersion,
  cliInstalled: Boolean(state.cliInstalled),
  loggedIn: Boolean(state.loggedIn),
  accounts: (Array.isArray(state.accounts) ? state.accounts : [])
    .map((entry) => normalizeComposioAccount(entry))
    .filter(Boolean),
  refreshedAt: Number.isFinite(state.refreshedAt) ? state.refreshedAt : null,
  lastError: String(state.lastError || "").trim(),
});

const readComposioState = ({ fs, statePath }) => {
  try {
    if (!fs.existsSync(statePath)) return createEmptyComposioState();
    return normalizeComposioState(
      JSON.parse(fs.readFileSync(statePath, "utf8")),
    );
  } catch {
    return createEmptyComposioState();
  }
};

const writeComposioState = ({ fs, statePath, state }) => {
  const normalized = normalizeComposioState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
};

// Composio CLI versions differ in their list envelope; accept the common
// shapes: a bare array, or an object wrapping it in items/accounts/data.
const parseConnectedAccountsOutput = (stdout) => {
  const parsed = parseJsonSafe(stdout, null, { trim: true });
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["items", "accounts", "data", "connectedAccounts"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  return null;
};

const looksLikeAuthError = (text = "") => {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("login") ||
    normalized.includes("unauthorized") ||
    normalized.includes("api key") ||
    normalized.includes("api_key") ||
    normalized.includes("authenticate")
  );
};

const listGoogleWorkspaceAccounts = (state = {}) =>
  (Array.isArray(state.accounts) ? state.accounts : []).filter(
    (account) =>
      account?.active && kGoogleWorkspaceToolkits.includes(account.toolkit),
  );

const refreshComposioState = async ({ fs, statePath, composioCmd }) => {
  const next = createEmptyComposioState();

  const versionResult = await composioCmd("--version", { quiet: true });
  next.cliInstalled = versionResult.ok;
  if (!next.cliInstalled) {
    next.lastError = "composio CLI not found";
    next.refreshedAt = Date.now();
    return writeComposioState({ fs, statePath, state: next });
  }

  const listResult = await composioCmd("connected-accounts list --json", {
    quiet: true,
  });
  if (listResult.ok) {
    const entries = parseConnectedAccountsOutput(listResult.stdout);
    next.loggedIn = true;
    next.accounts = Array.isArray(entries) ? entries : [];
    if (!Array.isArray(entries)) {
      next.lastError = "Could not parse connected-accounts output";
    }
  } else {
    next.loggedIn = !looksLikeAuthError(
      `${listResult.stderr}\n${listResult.stdout}`,
    );
    next.lastError =
      String(listResult.stderr || "").slice(0, 300) ||
      "composio connected-accounts list failed";
  }

  next.refreshedAt = Date.now();
  return writeComposioState({ fs, statePath, state: next });
};

module.exports = {
  kComposioStateVersion,
  kGoogleWorkspaceToolkits,
  composioStatePath,
  createEmptyComposioState,
  normalizeComposioAccount,
  normalizeComposioState,
  readComposioState,
  writeComposioState,
  parseConnectedAccountsOutput,
  listGoogleWorkspaceAccounts,
  refreshComposioState,
};
