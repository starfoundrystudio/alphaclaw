const path = require("path");
const { parseJsonSafe } = require("./utils/json");
const { parseComposioVersion } = require("./composio-install");

const kComposioStateVersion = 1;

// Toolkit slugs Composio uses for Google Workspace services. Matching is
// underscore-insensitive (see normalizeToolkitKey) because CLI surfaces have
// used both "googlecalendar" and "google_calendar" style slugs.
const kGoogleWorkspaceToolkits = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googledocs",
  "googlesheets",
  "googletasks",
  "googlemeet",
];

const normalizeToolkitKey = (slug = "") =>
  String(slug || "").trim().toLowerCase().replace(/[_-]/g, "");

const isGoogleWorkspaceToolkit = (slug = "") =>
  kGoogleWorkspaceToolkits.some(
    (toolkit) => normalizeToolkitKey(toolkit) === normalizeToolkitKey(slug),
  );

const composioStatePath = (openclawDir) =>
  path.join(openclawDir, "composio", "state.json");

const normalizeComposioGmailWatch = (gmailWatch = {}) => {
  const enabled = Boolean(gmailWatch?.enabled);
  const asPositiveInt = (value) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    enabled,
    pid: enabled ? asPositiveInt(gmailWatch?.pid) : null,
    startedAt: asPositiveInt(gmailWatch?.startedAt),
    lastEventAt: asPositiveInt(gmailWatch?.lastEventAt),
    lastError: String(gmailWatch?.lastError || "").trim(),
  };
};

const createEmptyComposioState = () => ({
  version: kComposioStateVersion,
  cliInstalled: false,
  cliVersion: "",
  loggedIn: false,
  account: { email: "", orgName: "" },
  accounts: [],
  gmailWatch: normalizeComposioGmailWatch({}),
  refreshedAt: null,
  lastError: "",
});

// `composio whoami` prints account JSON when authenticated and nothing to a
// non-TTY pipe when not, e.g.:
// {"account_type":"human","email":"a@b.com","current_org_name":"ws",...}
const parseWhoamiOutput = (stdout) => {
  const parsed = parseJsonSafe(stdout, null, { trim: true });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return {
    email: String(parsed.email || "").trim(),
    orgName: String(parsed.current_org_name || parsed.org_name || "").trim(),
  };
};

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
      entry.word_id ||
      entry.wordId ||
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
        entry.alias ||
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
  cliVersion: String(state.cliVersion || "").trim(),
  loggedIn: Boolean(state.loggedIn),
  account: {
    email: String(state.account?.email || "").trim(),
    orgName: String(state.account?.orgName || "").trim(),
  },
  accounts: (Array.isArray(state.accounts) ? state.accounts : [])
    .map((entry) => normalizeComposioAccount(entry))
    .filter(Boolean),
  gmailWatch: normalizeComposioGmailWatch(state.gmailWatch),
  refreshedAt: Number.isFinite(state.refreshedAt) ? state.refreshedAt : null,
  lastError: String(state.lastError || "").trim(),
});

const setComposioGmailWatch = ({ state = {}, watch = {} }) => {
  const nextState = normalizeComposioState(state);
  nextState.gmailWatch = normalizeComposioGmailWatch({
    ...nextState.gmailWatch,
    ...watch,
  });
  return { state: nextState, gmailWatch: nextState.gmailWatch };
};

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

// `composio connections list` prints toolkit connection statuses as JSON.
// Accept the common envelopes: a bare array, an object wrapping an array
// (items/connections/accounts/data), or a map of toolkit -> status/entry.
const parseConnectionsListOutput = (stdout) => {
  const parsed = parseJsonSafe(stdout, null, { trim: true });
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["items", "connections", "accounts", "data"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Map shape — the real 0.2.x CLI prints toolkit -> array of entries:
    //   { "gmail": [{ "status": "ACTIVE", "alias": null, "word_id": "..." }] }
    // Also accept toolkit -> entry object and toolkit -> status string.
    // A bare `{}` is the real CLI's output when no connections exist — an
    // empty, valid list.
    const entries = Object.entries(parsed);
    if (
      entries.every(
        ([, value]) => typeof value === "string" || typeof value === "object",
      )
    ) {
      return entries.flatMap(([toolkit, value]) => {
        if (typeof value === "string") return [{ toolkit, status: value }];
        if (Array.isArray(value)) {
          return value
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => ({ toolkit, ...entry }));
        }
        return [{ toolkit, ...value }];
      });
    }
  }
  return null;
};

const listGoogleWorkspaceAccounts = (state = {}) =>
  (Array.isArray(state.accounts) ? state.accounts : []).filter(
    (account) => account?.active && isGoogleWorkspaceToolkit(account.toolkit),
  );

const refreshComposioState = async ({ fs, statePath, composioCmd }) => {
  const next = createEmptyComposioState();
  // Refresh replaces CLI-derived fields; gmailWatch is AlphaClaw-managed
  // state and must survive the rebuild.
  next.gmailWatch = readComposioState({ fs, statePath }).gmailWatch;

  const versionResult = await composioCmd("version", { quiet: true });
  next.cliInstalled =
    versionResult.ok && Boolean(String(versionResult.stdout || "").trim());
  next.cliVersion = next.cliInstalled
    ? parseComposioVersion(versionResult.stdout)?.raw || ""
    : "";
  if (!next.cliInstalled) {
    next.lastError = "composio CLI not found";
    next.refreshedAt = Date.now();
    return writeComposioState({ fs, statePath, state: next });
  }

  // When there is no session, the CLI prints nothing to a non-TTY pipe and
  // exits 0 — so "logged in" is determined by whoami emitting parseable JSON,
  // not by the exit code.
  const whoamiResult = await composioCmd("whoami", { quiet: true });
  const account = parseWhoamiOutput(whoamiResult.stdout);
  if (!account) {
    next.loggedIn = false;
    next.lastError = "Not logged in — run `composio login`";
    next.refreshedAt = Date.now();
    return writeComposioState({ fs, statePath, state: next });
  }
  next.loggedIn = true;
  next.account = account;

  const listResult = await composioCmd("connections list", { quiet: true });
  const entries = parseConnectionsListOutput(listResult.stdout);
  if (entries) {
    next.accounts = entries;
  } else {
    const detail = String(listResult.stderr || listResult.stdout || "").trim();
    next.lastError = detail
      ? detail.slice(0, 300)
      : "Could not read connections list";
  }

  next.refreshedAt = Date.now();
  return writeComposioState({ fs, statePath, state: next });
};

module.exports = {
  kComposioStateVersion,
  kGoogleWorkspaceToolkits,
  normalizeToolkitKey,
  isGoogleWorkspaceToolkit,
  composioStatePath,
  createEmptyComposioState,
  normalizeComposioAccount,
  normalizeComposioState,
  normalizeComposioGmailWatch,
  setComposioGmailWatch,
  readComposioState,
  writeComposioState,
  parseConnectionsListOutput,
  parseWhoamiOutput,
  listGoogleWorkspaceAccounts,
  refreshComposioState,
};
