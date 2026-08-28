const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const childProcess = require("child_process");
const {
  CODEX_PROFILE_ID,
  OPENCLAW_DIR,
  ALPHACLAW_DIR,
  kOnboardingMarkerPath,
} = require("./constants");
const { hasOpenclawConfig } = require("./openclaw-runtime-state");
const { ensurePluginAllowed } = require("./usage-tracker-config");
const { isBrokeredCodexCredential } = require("../oauth-broker-constants");

const kDefaultAgentId = "main";
const kAuthProfileDatabaseFile = "openclaw-agent.sqlite";
const kAuthProfilePrimaryKey = "primary";
const kLegacyCodexAuthProvider = "openai-codex";
const kClaudeCliProfileId = "anthropic:claude-cli";
const kClaudeCliProviderId = "claude-cli";
const kInvalidAgentIdCharsRe = /[^a-z0-9_-]+/g;
const kLeadingDashRe = /^-+/;
const kTrailingDashRe = /-+$/;
const kAuthCredentialBackupPattern =
  /^(?:auth-profiles|auth)\.json\.(?:sqlite-import|openai-provider-unification|api-key-alias|legacy-flat|aws-sdk-profile|oauth-ref)\.\d+\.bak$/;
const kSharedOauthCredentialBackupPattern =
  /^oauth\.json\.(?:sqlite-import|openai-provider-unification|api-key-alias|legacy-flat|aws-sdk-profile|oauth-ref)\.\d+\.bak$/;
const kLegacyOauthSidecarPattern = /^[a-f0-9]{32}\.json$/;
const kApiKeyEnvVarByProvider = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
  kilocode: "KILOCODE_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  cohere: "COHERE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  novita: "NOVITA_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  volcengine: "VOLCANO_ENGINE_API_KEY",
  "volcengine-plan": "VOLCANO_ENGINE_API_KEY",
  byteplus: "BYTEPLUS_API_KEY",
  "byteplus-plan": "BYTEPLUS_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  minimax: "MINIMAX_API_KEY",
  voyage: "VOYAGE_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  vllm: "VLLM_API_KEY",
  "tencent-tokenhub": "TENCENT_TOKENHUB_API_KEY",
  together: "TOGETHER_API_KEY",
  venice: "VENICE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
};

const normalizeSecret = (raw) =>
  String(raw ?? "")
    .replace(/[\r\n\u2028\u2029]/g, "")
    .trim();

const normalizeAgentId = (value = kDefaultAgentId) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return kDefaultAgentId;
  return (
    trimmed
      .toLowerCase()
      .replace(kInvalidAgentIdCharsRe, "-")
      .replace(kLeadingDashRe, "")
      .replace(kTrailingDashRe, "")
      .slice(0, 64) || kDefaultAgentId
  );
};

const normalizeAuthIdentifier = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const credentialMode = (credential) => {
  if (credential.type === "api_key") return "api_key";
  if (credential.type === "token") return "token";
  return "oauth";
};

const isCodexOauthEntry = (profileId, credential) =>
  normalizeAuthIdentifier(profileId) === CODEX_PROFILE_ID ||
  normalizeAuthIdentifier(credential?.provider) === kLegacyCodexAuthProvider ||
  normalizeAuthIdentifier(profileId).startsWith(
    `${kLegacyCodexAuthProvider}:`,
  ) ||
  (normalizeAuthIdentifier(credential?.provider) === "openai" &&
    (credential?.type === "oauth" || credential?.mode === "oauth"));

const getEnvVarForApiKeyProvider = (provider) =>
  kApiKeyEnvVarByProvider[String(provider || "").trim()] || "";

const listApiKeyProviders = () => Object.keys(kApiKeyEnvVarByProvider);

const getDefaultProfileIdForApiKeyProvider = (provider) => {
  const normalized = String(provider || "").trim();
  return normalized ? `${normalized}:default` : "";
};

const canPersistAuthStoreInOpenclaw = () =>
  fs.existsSync(kOnboardingMarkerPath) ||
  hasOpenclawConfig({
    fs,
    openclawDir: OPENCLAW_DIR,
  });

const resolveAgentTargetId = (agentTarget = kDefaultAgentId) =>
  typeof agentTarget === "object" && agentTarget
    ? String(agentTarget.agentId || kDefaultAgentId)
    : String(agentTarget || kDefaultAgentId);

const resolvePendingAuthProfilesPath = (agentTarget = kDefaultAgentId) =>
  path.join(
    ALPHACLAW_DIR,
    "pending-auth-profiles",
    `${normalizeAgentId(resolveAgentTargetId(agentTarget))}.json`,
  );

const resolveConfiguredPath = (value) => {
  const configured = String(value || "").trim();
  if (!configured) return null;
  const homeDir = path.dirname(OPENCLAW_DIR);
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/"))
    return path.join(homeDir, configured.slice(2));
  return path.isAbsolute(configured) ? configured : path.resolve(configured);
};

let effectiveAgentEntriesCache = null;

const configRequiresEffectiveResolution = (parsedConfig) => {
  if (Object.prototype.hasOwnProperty.call(parsedConfig || {}, "$include")) {
    return true;
  }
  const serializedAgents = JSON.stringify(parsedConfig?.agents || {});
  return (
    serializedAgents.includes("${") || serializedAgents.includes('"$include"')
  );
};

const getEffectiveAgentEntriesCacheKey = (rawConfig, parsedConfig) =>
  crypto
    .createHash("sha256")
    .update(
      parsedConfig
        ? JSON.stringify({
            $include: parsedConfig.$include,
            agents: parsedConfig.agents,
          })
        : rawConfig,
    )
    .update("\0")
    .update(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([key]) => !key.startsWith("VITEST"))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");

const readEffectiveAgentEntries = () => {
  const openclawCli = require.resolve("openclaw/cli-entry");
  const cliEnv = Object.fromEntries(
    Object.entries({
      ...process.env,
      OPENCLAW_HOME: path.dirname(OPENCLAW_DIR),
      OPENCLAW_CONFIG_PATH: resolveOpenclawConfigPath(),
      OPENCLAW_STATE_DIR: OPENCLAW_DIR,
      XDG_CONFIG_HOME: OPENCLAW_DIR,
    }).filter(([key]) => !key.startsWith("VITEST")),
  );
  try {
    const output = childProcess.execFileSync(
      process.execPath,
      [openclawCli, "config", "get", "agents", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: cliEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const agents = JSON.parse(output);
    return Array.isArray(agents?.list) ? agents.list : [];
  } catch (error) {
    const wrapped = new Error(
      "Could not resolve OpenClaw's effective agent configuration; refusing to mutate brokered OAuth credentials",
    );
    wrapped.code = "effective_agent_config_unavailable";
    wrapped.cause = error;
    throw wrapped;
  }
};

const readConfiguredAgentEntries = ({ forceEffectiveRefresh = false } = {}) => {
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
  let rawConfig;
  try {
    rawConfig = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let cfg;
  try {
    cfg = JSON.parse(rawConfig);
  } catch {
    cfg = null;
  }
  if (cfg && !configRequiresEffectiveResolution(cfg)) {
    return Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  }
  const cacheKey = getEffectiveAgentEntriesCacheKey(rawConfig, cfg);
  if (!forceEffectiveRefresh && effectiveAgentEntriesCache?.key === cacheKey) {
    return effectiveAgentEntriesCache.entries;
  }
  const entries = readEffectiveAgentEntries();
  effectiveAgentEntriesCache = { key: cacheKey, entries };
  return entries;
};

const resolveAgentDir = (agentTarget = kDefaultAgentId) => {
  if (typeof agentTarget === "object" && agentTarget?.agentDir) {
    return path.resolve(agentTarget.agentDir);
  }
  const normalizedAgentId = normalizeAgentId(resolveAgentTargetId(agentTarget));
  const configuredEntry = readConfiguredAgentEntries().find(
    (entry) => normalizeAgentId(entry?.id) === normalizedAgentId,
  );
  const configuredDir = resolveConfiguredPath(configuredEntry?.agentDir);
  if (configuredDir) return configuredDir;
  if (normalizedAgentId === kDefaultAgentId) {
    const environmentDir = resolveConfiguredPath(
      process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR,
    );
    if (environmentDir) return environmentDir;
  }
  return path.join(OPENCLAW_DIR, "agents", normalizedAgentId, "agent");
};

const resolveAuthProfilesPath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "auth-profiles.json");

const resolveAuthProfileDatabasePath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), kAuthProfileDatabaseFile);

const resolveOpenclawConfigPath = () =>
  path.join(OPENCLAW_DIR, "openclaw.json");

const resolveLegacyAuthPath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "auth.json");

const resolveOauthDir = () =>
  resolveConfiguredPath(process.env.OPENCLAW_OAUTH_DIR) ||
  path.join(OPENCLAW_DIR, "credentials");

const resolveSharedOauthPath = () => path.join(resolveOauthDir(), "oauth.json");

const listOpenclawAgentTargets = () => {
  const targets = [];
  const seenDirectories = new Set();
  const addTarget = (agentId, agentDir) => {
    const resolvedDir = path.resolve(agentDir);
    if (seenDirectories.has(resolvedDir)) return;
    seenDirectories.add(resolvedDir);
    targets.push({
      agentId: String(agentId || kDefaultAgentId),
      agentDir: resolvedDir,
    });
  };
  // Security mutations always bypass the request-path cache so newly included
  // agent stores cannot escape a credential sweep.
  const configuredEntries = readConfiguredAgentEntries({
    forceEffectiveRefresh: true,
  });
  const configuredMain = configuredEntries.find(
    (entry) => normalizeAgentId(entry?.id) === kDefaultAgentId,
  );
  addTarget(
    kDefaultAgentId,
    resolveConfiguredPath(configuredMain?.agentDir) ||
      resolveConfiguredPath(
        process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR,
      ) ||
      path.join(OPENCLAW_DIR, "agents", kDefaultAgentId, "agent"),
  );
  for (const entry of configuredEntries) {
    if (!entry?.id) continue;
    const configuredDir = resolveConfiguredPath(entry.agentDir);
    addTarget(
      normalizeAgentId(entry.id),
      configuredDir ||
        path.join(OPENCLAW_DIR, "agents", normalizeAgentId(entry.id), "agent"),
    );
  }
  const agentsDir = path.join(OPENCLAW_DIR, "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const agentDir = path.join(agentsDir, entry.name, "agent");
      try {
        if (fs.statSync(agentDir).isDirectory()) {
          addTarget(entry.name, agentDir);
        }
      } catch {}
    }
  } catch {}
  return targets;
};

const getOauthRefId = (credential) => {
  const id = String(credential?.oauthRef?.id || "");
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
};

const hasDurableCodexRefresh = (profileId, credential) =>
  isCodexOauthEntry(profileId, credential) &&
  typeof credential?.refresh === "string" &&
  credential.refresh.trim() !== "" &&
  !isBrokeredCodexCredential(credential);

const listPersistedCodexOauthSecrets = (profileId, credential) => {
  if (!isCodexOauthEntry(profileId, credential)) return [];
  const secrets = [];
  if (
    typeof credential?.access === "string" &&
    credential.access.trim() !== ""
  ) {
    secrets.push(credential.access);
  }
  if (hasDurableCodexRefresh(profileId, credential)) {
    secrets.push(credential.refresh);
  }
  return secrets;
};

const removeCodexEntriesFromStore = (
  store,
  { preserveProfileId = null, replacementCredential = null } = {},
) => {
  const removedProfileIds = [];
  const removedOauthRefIds = [];
  let requiresPhysicalSanitization = false;
  for (const [profileId, credential] of Object.entries(store.profiles || {})) {
    if (!isCodexOauthEntry(profileId, credential)) continue;
    const retainedSecrets =
      profileId === preserveProfileId && replacementCredential
        ? new Set(
            listPersistedCodexOauthSecrets(
              preserveProfileId,
              replacementCredential,
            ),
          )
        : new Set();
    if (
      listPersistedCodexOauthSecrets(profileId, credential).some(
        (secret) => !retainedSecrets.has(secret),
      )
    ) {
      requiresPhysicalSanitization = true;
    }
    const oauthRefId = getOauthRefId(credential);
    if (oauthRefId) removedOauthRefIds.push(oauthRefId);
    if (profileId === preserveProfileId) continue;
    delete store.profiles[profileId];
    removedProfileIds.push(profileId);
  }
  const removedSet = new Set(removedProfileIds);
  for (const provider of Object.keys(store.order || {})) {
    if (!Array.isArray(store.order[provider])) continue;
    store.order[provider] = store.order[provider].filter(
      (profileId) => !removedSet.has(profileId),
    );
    if (store.order[provider].length === 0) delete store.order[provider];
  }
  if (store.lastGood && typeof store.lastGood === "object") {
    for (const [provider, profileId] of Object.entries(store.lastGood)) {
      if (removedSet.has(profileId)) delete store.lastGood[provider];
    }
  }
  if (store.usageStats && typeof store.usageStats === "object") {
    for (const profileId of removedSet) delete store.usageStats[profileId];
  }
  return {
    removedProfileIds,
    removedOauthRefIds,
    requiresPhysicalSanitization,
  };
};

const writeJsonFileAtomically = (filePath, value) => {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp.${process.pid}.${crypto
    .randomBytes(8)
    .toString("hex")}`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const hasCompletedOnboardingConfig = (cfg) =>
  String(cfg?.agents?.defaults?.model?.primary || "")
    .trim()
    .includes("/");

const readAuthStoreFile = (storePath) => {
  if (!fs.existsSync(storePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.profiles &&
      typeof parsed.profiles === "object"
    ) {
      return {
        version: Number(parsed.version || 1),
        profiles: parsed.profiles,
        order: parsed.order,
        lastGood: parsed.lastGood,
        usageStats: parsed.usageStats,
      };
    }
  } catch {}
  return null;
};

const normalizeLoadedAuthStore = (parsed) => {
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.profiles &&
    typeof parsed.profiles === "object"
  ) {
    return {
      version: Number(parsed.version || 1),
      profiles: parsed.profiles,
      order: parsed.order,
      lastGood: parsed.lastGood,
      usageStats: parsed.usageStats,
    };
  }
  return null;
};

const withNodeSqlite = (callback) => {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return null;
  }
  return callback(sqlite);
};

const readAuthStoreDatabase = (agentId = kDefaultAgentId) => {
  const databasePath = resolveAuthProfileDatabasePath(agentId);
  if (!fs.existsSync(databasePath)) return null;
  return withNodeSqlite((sqlite) => {
    let db;
    try {
      db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      const storeRow = db
        .prepare(
          "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        )
        .get(kAuthProfilePrimaryKey);
      if (!storeRow?.store_json) return null;
      const stateRow = db
        .prepare(
          "SELECT state_json FROM auth_profile_state WHERE state_key = ?",
        )
        .get(kAuthProfilePrimaryKey);
      const parsedStore = JSON.parse(storeRow.store_json);
      const parsedState = stateRow?.state_json
        ? JSON.parse(stateRow.state_json)
        : {};
      return normalizeLoadedAuthStore({
        ...parsedStore,
        ...(parsedState && typeof parsedState === "object" ? parsedState : {}),
      });
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {}
    }
  });
};

const ensureAuthProfileDatabaseSchema = (db, agentId) => {
  const normalizedAgentId = normalizeAgentId(resolveAgentTargetId(agentId));
  const existingOwner = (() => {
    try {
      const schemaMeta = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
        )
        .get();
      if (!schemaMeta) return null;
      const row = db
        .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = ?")
        .get(kAuthProfilePrimaryKey);
      if (!row) return null;
      return {
        role: typeof row.role === "string" ? row.role : "",
        agentId: typeof row.agent_id === "string" ? row.agent_id : "",
      };
    } catch {
      return null;
    }
  })();
  if (existingOwner) {
    if (existingOwner.role !== "agent") {
      throw new Error(
        `OpenClaw auth database has schema role ${existingOwner.role || "unknown"}; expected agent.`,
      );
    }
    if (!existingOwner.agentId) {
      throw new Error("OpenClaw auth database has no agent owner.");
    }
    if (normalizeAgentId(existingOwner.agentId) !== normalizedAgentId) {
      throw new Error(
        `OpenClaw auth database belongs to agent ${existingOwner.agentId}; requested agent ${normalizedAgentId}.`,
      );
    }
  }
  const now = Date.now();
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS schema_meta (
      meta_key TEXT NOT NULL PRIMARY KEY,
      role TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      agent_id TEXT,
      app_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_profile_store (
      store_key TEXT NOT NULL PRIMARY KEY,
      store_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_profile_state (
      state_key TEXT NOT NULL PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        agent_id,
        app_version,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET
        role = excluded.role,
        schema_version = excluded.schema_version,
        agent_id = excluded.agent_id,
        app_version = excluded.app_version,
        updated_at = excluded.updated_at
    `,
  ).run(kAuthProfilePrimaryKey, "agent", 1, normalizedAgentId, null, now, now);
};

const writeAuthStoreRows = (db, store) => {
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO auth_profile_store (store_key, store_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(store_key) DO UPDATE SET
        store_json = excluded.store_json,
        updated_at = excluded.updated_at
    `,
  ).run(
    kAuthProfilePrimaryKey,
    JSON.stringify({
      version: Number(store.version || 1),
      profiles: store.profiles || {},
    }),
    now,
  );
  const statePayload =
    store.order !== undefined ||
    store.lastGood !== undefined ||
    store.usageStats !== undefined
      ? {
          version: Number(store.version || 1),
          ...(store.order !== undefined ? { order: store.order } : {}),
          ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
          ...(store.usageStats !== undefined
            ? { usageStats: store.usageStats }
            : {}),
        }
      : null;
  if (statePayload) {
    db.prepare(
      `
        INSERT INTO auth_profile_state (state_key, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `,
    ).run(kAuthProfilePrimaryKey, JSON.stringify(statePayload), now);
  } else {
    db.prepare("DELETE FROM auth_profile_state WHERE state_key = ?").run(
      kAuthProfilePrimaryKey,
    );
  }
};

const physicallySanitizeAuthProfileDatabase = (db) => {
  db.exec("PRAGMA secure_delete = ON;");
  const checkpoint = () => {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
    const busy = Number(result?.busy ?? Object.values(result || {})[0] ?? 0);
    if (busy !== 0) {
      const error = new Error("OpenClaw auth database WAL checkpoint is busy");
      error.code = "auth_database_checkpoint_busy";
      throw error;
    }
  };
  checkpoint();
  // Rebuild the database so the superseded refresh-token row cannot remain in
  // SQLite free pages, then truncate any WAL frames created by the rebuild.
  db.exec("VACUUM;");
  checkpoint();
};

const resolveAuthDatabaseSanitizationMarkerPath = (databasePath) =>
  `${databasePath}.alphaclaw-oauth-sanitize-pending`;

const markAuthDatabaseSanitizationPending = (databasePath) => {
  writeJsonFileAtomically(
    resolveAuthDatabaseSanitizationMarkerPath(databasePath),
    {
      schemaVersion: 1,
      kind: "codex-oauth-physical-sanitization",
      requestedAt: Date.now(),
    },
  );
};

const clearAuthDatabaseSanitizationPending = (databasePath) => {
  const markerPath = resolveAuthDatabaseSanitizationMarkerPath(databasePath);
  const directory = path.dirname(markerPath);
  fs.rmSync(markerPath, { force: true });
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const writeAuthStoreDatabase = (agentId = kDefaultAgentId, store) => {
  const databasePath = resolveAuthProfileDatabasePath(agentId);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  return withNodeSqlite((sqlite) => {
    let db;
    try {
      db = new sqlite.DatabaseSync(databasePath);
      ensureAuthProfileDatabaseSchema(db, agentId);
      db.exec("BEGIN IMMEDIATE;");
      writeAuthStoreRows(db, store);
      db.exec("COMMIT;");
      fs.chmodSync(databasePath, 0o600);
      return true;
    } catch (err) {
      try {
        db?.exec("ROLLBACK;");
      } catch {}
      throw err;
    } finally {
      try {
        db?.close();
      } catch {}
    }
  });
};

const mutateAuthStoreDatabase = (agentId, mutate) => {
  const databasePath = resolveAuthProfileDatabasePath(agentId);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  return withNodeSqlite((sqlite) => {
    let db;
    try {
      db = new sqlite.DatabaseSync(databasePath);
      ensureAuthProfileDatabaseSchema(db, agentId);
      // Read and write under the same SQLite writer lock. This prevents the
      // proactive OAuth refresh loop from replacing usage state or unrelated
      // profiles committed by OpenClaw between a separate read and write.
      db.exec("BEGIN IMMEDIATE;");
      const storeRow = db
        .prepare(
          "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        )
        .get(kAuthProfilePrimaryKey);
      const stateRow = db
        .prepare(
          "SELECT state_json FROM auth_profile_state WHERE state_key = ?",
        )
        .get(kAuthProfilePrimaryKey);
      const databaseStore = storeRow?.store_json
        ? normalizeLoadedAuthStore({
            ...JSON.parse(storeRow.store_json),
            ...(stateRow?.state_json ? JSON.parse(stateRow.state_json) : {}),
          })
        : null;
      const legacyStore = readAuthStoreFile(resolveAuthProfilesPath(agentId));
      const pendingStore = readAuthStoreFile(
        resolvePendingAuthProfilesPath(agentId),
      );
      const store = mergeAuthStores(
        mergeAuthStores(
          mergeAuthStores({ version: 1, profiles: {} }, legacyStore),
          databaseStore,
        ),
        pendingStore,
      );
      const result = mutate(store);
      const sanitizationPending = fs.existsSync(
        resolveAuthDatabaseSanitizationMarkerPath(databasePath),
      );
      const requiresPhysicalSanitization =
        sanitizationPending || result?.requiresPhysicalSanitization === true;
      if (requiresPhysicalSanitization && !sanitizationPending) {
        // This marker must be durable before the row replacement commits. A
        // busy checkpoint, failed VACUUM, or crash then remains recoverable
        // even though the next read sees only the non-secret broker marker.
        markAuthDatabaseSanitizationPending(databasePath);
      }
      writeAuthStoreRows(db, store);
      db.exec("COMMIT;");
      if (requiresPhysicalSanitization) {
        physicallySanitizeAuthProfileDatabase(db);
        clearAuthDatabaseSanitizationPending(databasePath);
      }
      fs.chmodSync(databasePath, 0o600);
      return { wrote: true, result };
    } catch (err) {
      try {
        db?.exec("ROLLBACK;");
      } catch {}
      throw err;
    } finally {
      try {
        db?.close();
      } catch {}
    }
  });
};

const mergeAuthStores = (
  baseStore = { version: 1, profiles: {} },
  overlayStore,
) => {
  if (!overlayStore) return baseStore;
  return {
    version: Number(overlayStore.version || baseStore.version || 1),
    profiles: {
      ...(baseStore.profiles || {}),
      ...(overlayStore.profiles || {}),
    },
    ...(baseStore.order !== undefined ? { order: baseStore.order } : {}),
    ...(baseStore.lastGood !== undefined
      ? { lastGood: baseStore.lastGood }
      : {}),
    ...(baseStore.usageStats !== undefined
      ? { usageStats: baseStore.usageStats }
      : {}),
    ...(overlayStore.order !== undefined ? { order: overlayStore.order } : {}),
    ...(overlayStore.lastGood !== undefined
      ? { lastGood: overlayStore.lastGood }
      : {}),
    ...(overlayStore.usageStats !== undefined
      ? { usageStats: overlayStore.usageStats }
      : {}),
  };
};

const loadAuthStore = (agentId = kDefaultAgentId) => {
  const store = { version: 1, profiles: {} };
  const pendingStore = readAuthStoreFile(
    resolvePendingAuthProfilesPath(agentId),
  );
  if (!canPersistAuthStoreInOpenclaw()) {
    return mergeAuthStores(store, pendingStore);
  }

  const openclawDatabaseStore = readAuthStoreDatabase(agentId);
  const openclawStore = readAuthStoreFile(resolveAuthProfilesPath(agentId));
  return mergeAuthStores(
    mergeAuthStores(
      mergeAuthStores(store, openclawStore),
      openclawDatabaseStore,
    ),
    pendingStore,
  );
};

const saveAuthStore = (agentId, store) => {
  const pendingStorePath = resolvePendingAuthProfilesPath(agentId);
  const persistInOpenclaw = canPersistAuthStoreInOpenclaw();
  if (persistInOpenclaw) {
    const wroteDatabase = writeAuthStoreDatabase(agentId, store);
    if (wroteDatabase) {
      // SQLite is the 2026.7.1 provider-auth source of truth. Once the merged
      // store is durable there, retire any legacy JSON duplicate so an old
      // refresh token cannot remain on disk or be merged back in later.
      const legacyStorePath = resolveAuthProfilesPath(agentId);
      if (fs.existsSync(legacyStorePath)) {
        fs.rmSync(legacyStorePath, { force: true });
      }
      if (fs.existsSync(pendingStorePath)) {
        fs.rmSync(pendingStorePath, { force: true });
      }
      return;
    }
  }
  const storePath = persistInOpenclaw
    ? resolveAuthProfilesPath(agentId)
    : pendingStorePath;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        version: Number(store.version || 1),
        profiles: store.profiles || {},
        ...(store.order !== undefined ? { order: store.order } : {}),
        ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
        ...(store.usageStats !== undefined
          ? { usageStats: store.usageStats }
          : {}),
      },
      null,
      2,
    ),
  );
  if (storePath !== pendingStorePath && fs.existsSync(pendingStorePath)) {
    fs.rmSync(pendingStorePath, { force: true });
  }
};

const mutateAuthStore = (agentId, mutate) => {
  if (canPersistAuthStoreInOpenclaw()) {
    const databaseResult = mutateAuthStoreDatabase(agentId, mutate);
    if (databaseResult?.wrote) {
      for (const stalePath of [
        resolveAuthProfilesPath(agentId),
        resolvePendingAuthProfilesPath(agentId),
      ]) {
        if (fs.existsSync(stalePath)) fs.rmSync(stalePath, { force: true });
      }
      return databaseResult.result;
    }
  }
  const store = loadAuthStore(agentId);
  const result = mutate(store);
  saveAuthStore(agentId, store);
  return result;
};

const scrubLegacyAuthJson = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(
      `Could not inspect legacy OAuth store ${filePath}`,
    );
    wrapped.code = "legacy_auth_store_invalid";
    wrapped.cause = error;
    throw wrapped;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  let changed = false;
  const removedOauthRefIds = [];
  if (raw.profiles && typeof raw.profiles === "object") {
    const removed = new Set();
    for (const [profileId, credential] of Object.entries(raw.profiles)) {
      if (!isCodexOauthEntry(profileId, credential)) continue;
      const oauthRefId = getOauthRefId(credential);
      if (oauthRefId) removedOauthRefIds.push(oauthRefId);
      delete raw.profiles[profileId];
      removed.add(profileId);
      changed = true;
    }
    if (removed.size > 0) {
      for (const key of ["order", "lastGood", "usageStats"]) {
        if (!raw[key] || typeof raw[key] !== "object") continue;
        for (const [entryKey, entryValue] of Object.entries(raw[key])) {
          if (Array.isArray(entryValue)) {
            raw[key][entryKey] = entryValue.filter((id) => !removed.has(id));
            if (raw[key][entryKey].length === 0) delete raw[key][entryKey];
          } else if (removed.has(entryKey) || removed.has(entryValue)) {
            delete raw[key][entryKey];
          }
        }
        if (Object.keys(raw[key]).length === 0) delete raw[key];
      }
    }
  } else {
    for (const [provider, credential] of Object.entries(raw)) {
      const credentialType = credential?.type || credential?.mode;
      const looksLikeOauth =
        credentialType === "oauth" ||
        typeof credential?.refresh === "string" ||
        typeof credential?.access === "string";
      if (
        normalizeAuthIdentifier(provider) === kLegacyCodexAuthProvider ||
        isCodexOauthEntry(provider, credential) ||
        (normalizeAuthIdentifier(provider) === "openai" && looksLikeOauth)
      ) {
        const oauthRefId = getOauthRefId(credential);
        if (oauthRefId) removedOauthRefIds.push(oauthRefId);
        delete raw[provider];
        changed = true;
      }
    }
  }
  if (changed) writeJsonFileAtomically(filePath, raw);
  return removedOauthRefIds;
};

const scrubSharedOauthJson = () => {
  const oauthPath = resolveSharedOauthPath();
  if (!fs.existsSync(oauthPath)) return;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
  } catch (error) {
    const wrapped = new Error(
      `Could not inspect legacy OAuth store ${oauthPath}`,
    );
    wrapped.code = "legacy_auth_store_invalid";
    wrapped.cause = error;
    throw wrapped;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  let changed = false;
  for (const provider of Object.keys(raw)) {
    if (
      !["openai", kLegacyCodexAuthProvider].includes(
        normalizeAuthIdentifier(provider),
      )
    )
      continue;
    delete raw[provider];
    changed = true;
  }
  if (changed) writeJsonFileAtomically(oauthPath, raw);
};

const purgeLegacyCodexCredentialArtifacts = (agentId = kDefaultAgentId) => {
  const removedOauthRefIds = [
    ...scrubLegacyAuthJson(resolveAuthProfilesPath(agentId)),
    ...scrubLegacyAuthJson(resolveLegacyAuthPath(agentId)),
  ];
  scrubSharedOauthJson();

  const agentDir = resolveAgentDir(agentId);
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir)) {
      if (!kAuthCredentialBackupPattern.test(entry)) continue;
      fs.rmSync(path.join(agentDir, entry), { force: true });
    }
  }

  const credentialsDir = path.dirname(resolveSharedOauthPath());
  if (fs.existsSync(credentialsDir)) {
    for (const entry of fs.readdirSync(credentialsDir)) {
      if (kSharedOauthCredentialBackupPattern.test(entry)) {
        fs.rmSync(path.join(credentialsDir, entry), { force: true });
      }
    }
  }
  return removedOauthRefIds;
};

const collectReferencedOauthRefIds = (agentIds) => {
  const referenced = new Set();
  for (const agentId of agentIds) {
    const store = loadAuthStore(agentId);
    for (const credential of Object.values(store.profiles || {})) {
      const oauthRefId = getOauthRefId(credential);
      if (oauthRefId) referenced.add(oauthRefId);
    }
  }
  return referenced;
};

const purgeRemovedLegacyOauthSidecars = (removedOauthRefIds, agentIds) => {
  const referenced = collectReferencedOauthRefIds(agentIds);
  const sidecarDir = path.join(
    path.dirname(resolveSharedOauthPath()),
    "auth-profiles",
  );
  if (!fs.existsSync(sidecarDir)) return;
  const explicitlyRemoved = new Set(removedOauthRefIds);
  for (const entry of fs.readdirSync(sidecarDir)) {
    if (!kLegacyOauthSidecarPattern.test(entry)) continue;
    const oauthRefId = entry.slice(0, -5);
    if (referenced.has(oauthRefId)) continue;
    let payload = null;
    try {
      payload = JSON.parse(
        fs.readFileSync(path.join(sidecarDir, entry), "utf8"),
      );
    } catch {}
    const isCodexPayload =
      payload?.provider === kLegacyCodexAuthProvider ||
      payload?.provider === "openai" ||
      payload?.profileId === CODEX_PROFILE_ID ||
      String(payload?.profileId || "").startsWith(
        `${kLegacyCodexAuthProvider}:`,
      );
    if (!explicitlyRemoved.has(oauthRefId) && !isCodexPayload) continue;
    fs.rmSync(path.join(sidecarDir, entry), { force: true });
  }
};

const loadOpenclawConfig = () => {
  const configPath = resolveOpenclawConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
};

const getAgentRuntimeId = (value) => {
  const runtime = value?.agentRuntime;
  if (typeof runtime === "string") return runtime.trim();
  if (runtime && typeof runtime === "object") {
    return String(runtime.id || "").trim();
  }
  return "";
};

const kManagedAgentRuntimePlugins = {
  codex: "codex",
  "claude-cli": "anthropic",
};

const collectManagedAgentRuntimePlugins = (cfg = {}) => {
  const pluginIds = new Set();
  const addRuntime = (value) => {
    const runtimeId = getAgentRuntimeId(value);
    const pluginId = kManagedAgentRuntimePlugins[runtimeId];
    if (pluginId) pluginIds.add(pluginId);
  };

  addRuntime(cfg.agents?.defaults || {});
  for (const value of Object.values(cfg.agents?.defaults?.models || {})) {
    addRuntime(value);
  }
  for (const value of Object.values(cfg.models?.providers || {})) {
    addRuntime(value);
  }

  return [...pluginIds];
};

const enableManagedAgentRuntimePlugins = (cfg = {}) => {
  const pluginIds = collectManagedAgentRuntimePlugins(cfg);
  for (const pluginId of pluginIds) {
    ensurePluginAllowed({ cfg, pluginKey: pluginId });
    cfg.plugins.entries[pluginId] = {
      ...(cfg.plugins.entries[pluginId] &&
      typeof cfg.plugins.entries[pluginId] === "object"
        ? cfg.plugins.entries[pluginId]
        : {}),
      enabled: true,
    };
  }
  return pluginIds;
};

const canSyncOpenclawAuthReferences = () => {
  const configPath = resolveOpenclawConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return hasCompletedOnboardingConfig(cfg);
  } catch {
    return false;
  }
};

const saveOpenclawConfig = (cfg) => {
  writeJsonFileAtomically(resolveOpenclawConfigPath(), cfg);
};

const syncConfigAuthReference = (cfg, profileId, credential) => {
  const next = { ...cfg };
  if (!next.auth) next.auth = {};
  if (!next.auth.profiles) next.auth.profiles = {};
  next.auth = { ...next.auth, profiles: { ...next.auth.profiles } };
  next.auth.profiles[profileId] = {
    provider: credential.provider,
    mode: credentialMode(credential),
  };
  return next;
};

const syncConfigAuthOrder = (cfg, provider, orderedProfileIds) => {
  const next = { ...cfg };
  if (!next.auth) next.auth = {};
  next.auth = {
    ...next.auth,
    order: {
      ...(next.auth.order || {}),
      [provider]: orderedProfileIds,
    },
  };
  return next;
};

const removeConfigAuthReference = (cfg, profileId) => {
  if (!cfg.auth?.profiles?.[profileId] && !cfg.auth?.order) return cfg;
  const next = { ...cfg };
  next.auth = { ...next.auth };
  if (next.auth.profiles) {
    next.auth.profiles = { ...next.auth.profiles };
    delete next.auth.profiles[profileId];
    if (Object.keys(next.auth.profiles).length === 0) {
      delete next.auth.profiles;
    }
  }
  if (next.auth.order) {
    next.auth.order = Object.fromEntries(
      Object.entries(next.auth.order)
        .map(([provider, order]) => [
          provider,
          Array.isArray(order)
            ? order.filter((entry) => entry !== profileId)
            : order,
        ])
        .filter(([, order]) => !Array.isArray(order) || order.length > 0),
    );
    if (Object.keys(next.auth.order).length === 0) {
      delete next.auth.order;
    }
  }
  if (Object.keys(next.auth).length === 0) {
    delete next.auth;
  }
  return next;
};

const createAuthProfiles = () => {
  // ── Generic profile operations ──

  const listProfiles = (agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    return Object.entries(store.profiles || {}).map(([id, cred]) => ({
      id,
      ...cred,
    }));
  };

  const listProfilesByProvider = (provider, agentId = kDefaultAgentId) =>
    listProfiles(agentId).filter((p) => p.provider === provider);

  const getProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    const cred = store.profiles?.[profileId];
    if (!cred) return null;
    return { id: profileId, ...cred };
  };

  const upsertProfile = (profileId, credential, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    const sanitized = { ...credential };
    if (sanitized.key) sanitized.key = normalizeSecret(sanitized.key);
    if (sanitized.token) sanitized.token = normalizeSecret(sanitized.token);
    if (sanitized.access) sanitized.access = normalizeSecret(sanitized.access);
    if (sanitized.refresh)
      sanitized.refresh = normalizeSecret(sanitized.refresh);
    store.profiles[profileId] = sanitized;
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return;
    const cfg = loadOpenclawConfig();
    const updated = syncConfigAuthReference(cfg, profileId, sanitized);
    saveOpenclawConfig(updated);
  };

  const removeProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    if (!store.profiles[profileId]) return false;
    delete store.profiles[profileId];
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return true;
    const cfg = loadOpenclawConfig();
    const updated = removeConfigAuthReference(cfg, profileId);
    saveOpenclawConfig(updated);
    return true;
  };

  const setAuthOrder = (
    provider,
    orderedProfileIds,
    agentId = kDefaultAgentId,
  ) => {
    const store = loadAuthStore(agentId);
    if (!store.order) store.order = {};
    store.order[provider] = orderedProfileIds;
    saveAuthStore(agentId, store);
    if (!canSyncOpenclawAuthReferences()) return;
    const cfg = loadOpenclawConfig();
    const updated = syncConfigAuthOrder(cfg, provider, orderedProfileIds);
    saveOpenclawConfig(updated);
  };

  const syncConfigAuthReferencesForAgent = (agentId = kDefaultAgentId) => {
    if (!canSyncOpenclawAuthReferences()) return;
    const pendingStorePath = resolvePendingAuthProfilesPath(agentId);
    if (fs.existsSync(pendingStorePath)) {
      saveAuthStore(agentId, loadAuthStore(agentId));
    }
    const store = loadAuthStore(agentId);
    let cfg = loadOpenclawConfig();
    for (const [profileId, credential] of Object.entries(
      store.profiles || {},
    )) {
      if (!credential?.type || !credential?.provider) continue;
      cfg = syncConfigAuthReference(cfg, profileId, credential);
    }
    for (const [provider, order] of Object.entries(store.order || {})) {
      if (Array.isArray(order)) {
        cfg = syncConfigAuthOrder(cfg, provider, order);
      }
    }
    saveOpenclawConfig(cfg);
  };

  const upsertApiKeyProfileForEnvVar = (
    provider,
    rawValue,
    agentId = kDefaultAgentId,
  ) => {
    const key = normalizeSecret(rawValue);
    if (!provider || !key) return false;
    upsertProfile(
      getDefaultProfileIdForApiKeyProvider(provider),
      {
        type: "api_key",
        provider,
        key,
      },
      agentId,
    );
    return true;
  };

  const removeApiKeyProfileForEnvVar = (
    provider,
    agentId = kDefaultAgentId,
  ) => {
    const profileId = getDefaultProfileIdForApiKeyProvider(provider);
    if (!profileId) return false;
    const existing = getProfile(profileId, agentId);
    if (!existing) return false;
    if (existing.type !== "api_key" || existing.provider !== provider)
      return false;
    return removeProfile(profileId, agentId);
  };

  // ── Model config operations ──

  const getModelConfig = () => {
    const cfg = loadOpenclawConfig();
    const defaults = cfg.agents?.defaults || {};
    const providerRuntimeIds = Object.fromEntries(
      Object.entries(cfg.models?.providers || {})
        .map(([provider, value]) => [provider, getAgentRuntimeId(value)])
        .filter(([, runtimeId]) => runtimeId),
    );
    const modelRuntimeIds = Object.fromEntries(
      Object.entries(defaults.models || {})
        .map(([modelKey, value]) => [modelKey, getAgentRuntimeId(value)])
        .filter(([, runtimeId]) => runtimeId),
    );
    return {
      primary: defaults.model?.primary || null,
      configuredModels: defaults.models || {},
      providerRuntimeIds,
      modelRuntimeIds,
    };
  };

  const setModelConfig = ({ primary, configuredModels }) => {
    const cfg = loadOpenclawConfig();
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    if (primary !== undefined) {
      cfg.agents.defaults.model.primary = primary;
    }
    if (configuredModels !== undefined) {
      cfg.agents.defaults.models = configuredModels;
    }
    const managedPluginIds = enableManagedAgentRuntimePlugins(cfg);
    saveOpenclawConfig(cfg);
    return { managedPluginIds };
  };

  // ── Codex-specific wrappers ──

  const isCodexProfile = (profile) => isCodexOauthEntry(profile?.id, profile);

  const listCodexProfiles = () =>
    listProfiles().filter(
      (profile) =>
        isCodexProfile(profile) ||
        (normalizeAuthIdentifier(profile.provider) === "openai" &&
          profile.type === "oauth"),
    );

  const getCodexProfile = () => {
    const profiles = listCodexProfiles();
    if (profiles.length === 0) return null;
    const preferred =
      profiles.find((p) => p.id === CODEX_PROFILE_ID) || profiles[0];
    return { profileId: preferred.id, ...preferred };
  };

  const hasCodexOauthProfile = () => {
    const profile = getCodexProfile();
    return !!(profile?.access && profile?.refresh);
  };

  const getClaudeCliProfile = () => {
    const profile = getProfile(kClaudeCliProfileId);
    if (!profile) return null;
    return profile.provider === kClaudeCliProviderId ? profile : null;
  };

  const hasClaudeCliProfile = () => !!getClaudeCliProfile();

  const upsertClaudeCliProfile = () => {
    upsertProfile(kClaudeCliProfileId, {
      type: "oauth",
      provider: kClaudeCliProviderId,
      updatedAt: Date.now(),
    });
    const store = loadAuthStore(kDefaultAgentId);
    const existingAnthropicOrder = Array.isArray(store.order?.anthropic)
      ? store.order.anthropic
      : [];
    setAuthOrder("anthropic", [
      kClaudeCliProfileId,
      ...existingAnthropicOrder.filter(
        (entry) => entry !== kClaudeCliProfileId,
      ),
    ]);
    const nextStore = loadAuthStore(kDefaultAgentId);
    nextStore.lastGood = {
      ...(nextStore.lastGood || {}),
      anthropic: kClaudeCliProfileId,
      [kClaudeCliProviderId]: kClaudeCliProfileId,
    };
    saveAuthStore(kDefaultAgentId, nextStore);
    if (canSyncOpenclawAuthReferences()) {
      let cfg = loadOpenclawConfig();
      cfg = syncConfigAuthReference(cfg, kClaudeCliProfileId, {
        type: "oauth",
        provider: kClaudeCliProviderId,
      });
      cfg = syncConfigAuthOrder(cfg, "anthropic", [
        kClaudeCliProfileId,
        ...existingAnthropicOrder.filter(
          (entry) => entry !== kClaudeCliProfileId,
        ),
      ]);
      saveOpenclawConfig(cfg);
    }
  };

  const upsertCodexProfile = ({ access, refresh, expires, accountId }) => {
    const credential = {
      type: "oauth",
      provider: "openai",
      access: normalizeSecret(access),
      refresh: normalizeSecret(refresh),
      expires,
      updatedAt: Date.now(),
      ...(accountId ? { accountId } : {}),
    };
    const agentIds = listOpenclawAgentTargets();
    const mainAgent =
      agentIds.find(
        (agent) =>
          normalizeAgentId(resolveAgentTargetId(agent)) === kDefaultAgentId,
      ) || kDefaultAgentId;
    const removedProfileIds = new Set();
    const removedOauthRefIds = [];
    const mutation = mutateAuthStore(mainAgent, (store) => {
      const cleanup = removeCodexEntriesFromStore(store, {
        preserveProfileId: CODEX_PROFILE_ID,
        replacementCredential: credential,
      });
      for (const profileId of cleanup.removedProfileIds) {
        removedProfileIds.add(profileId);
      }
      removedOauthRefIds.push(...cleanup.removedOauthRefIds);
      store.profiles[CODEX_PROFILE_ID] = credential;
      const existingOpenAiOrder = Array.isArray(store.order?.openai)
        ? store.order.openai
        : [];
      const nextOrder = [
        CODEX_PROFILE_ID,
        ...existingOpenAiOrder.filter(
          (entry) =>
            entry !== CODEX_PROFILE_ID && !removedProfileIds.has(entry),
        ),
      ];
      store.order = {
        ...(store.order || {}),
        openai: nextOrder,
      };
      return {
        openAiOrder: nextOrder,
        removedProfileIds: cleanup.removedProfileIds,
        requiresPhysicalSanitization: cleanup.requiresPhysicalSanitization,
      };
    });
    if (isBrokeredCodexCredential(credential)) {
      for (const agentId of agentIds) {
        if (resolveAgentDir(agentId) !== resolveAgentDir(mainAgent)) {
          const cleanup = mutateAuthStore(agentId, (store) =>
            removeCodexEntriesFromStore(store),
          );
          for (const profileId of cleanup.removedProfileIds) {
            removedProfileIds.add(profileId);
          }
          removedOauthRefIds.push(...cleanup.removedOauthRefIds);
        }
        removedOauthRefIds.push(
          ...purgeLegacyCodexCredentialArtifacts(agentId),
        );
      }
      purgeRemovedLegacyOauthSidecars(removedOauthRefIds, agentIds);
    }
    if (canSyncOpenclawAuthReferences()) {
      let cfg = loadOpenclawConfig();
      for (const profileId of removedProfileIds) {
        cfg = removeConfigAuthReference(cfg, profileId);
      }
      cfg = syncConfigAuthReference(cfg, CODEX_PROFILE_ID, credential);
      cfg = syncConfigAuthOrder(cfg, "openai", mutation.openAiOrder);
      saveOpenclawConfig(cfg);
    }
  };

  const removeCodexProfiles = () => {
    const agentIds = listOpenclawAgentTargets();
    const removedProfileIds = new Set();
    const removedOauthRefIds = [];
    for (const agentId of agentIds) {
      const cleanup = mutateAuthStore(agentId, (store) =>
        removeCodexEntriesFromStore(store),
      );
      for (const profileId of cleanup.removedProfileIds) {
        removedProfileIds.add(profileId);
      }
      removedOauthRefIds.push(
        ...cleanup.removedOauthRefIds,
        ...purgeLegacyCodexCredentialArtifacts(agentId),
      );
    }
    purgeRemovedLegacyOauthSidecars(removedOauthRefIds, agentIds);
    const changed = removedProfileIds.size > 0;
    if (canSyncOpenclawAuthReferences()) {
      let cfg = loadOpenclawConfig();
      const configProfileIds = new Set([
        CODEX_PROFILE_ID,
        ...removedProfileIds,
      ]);
      for (const [id, cred] of Object.entries(cfg.auth?.profiles || {})) {
        if (isCodexOauthEntry(id, cred)) configProfileIds.add(id);
      }
      for (const profileId of cfg.auth?.order?.openai || []) {
        if (
          normalizeAuthIdentifier(profileId) === CODEX_PROFILE_ID ||
          normalizeAuthIdentifier(profileId).startsWith(
            `${kLegacyCodexAuthProvider}:`,
          )
        ) {
          configProfileIds.add(profileId);
        }
      }
      for (const profileId of configProfileIds) {
        cfg = removeConfigAuthReference(cfg, profileId);
      }
      saveOpenclawConfig(cfg);
    }
    return changed;
  };

  return {
    listProfiles,
    listProfilesByProvider,
    getProfile,
    upsertProfile,
    removeProfile,
    setAuthOrder,
    syncConfigAuthReferencesForAgent,
    upsertApiKeyProfileForEnvVar,
    removeApiKeyProfileForEnvVar,
    getEnvVarForApiKeyProvider,
    listApiKeyProviders,
    getDefaultProfileIdForApiKeyProvider,
    getModelConfig,
    setModelConfig,
    getCodexProfile,
    hasCodexOauthProfile,
    upsertCodexProfile,
    removeCodexProfiles,
    getClaudeCliProfile,
    hasClaudeCliProfile,
    upsertClaudeCliProfile,
    loadAuthStore,
  };
};

module.exports = { createAuthProfiles, getEnvVarForApiKeyProvider };
