const fs = require("fs");
const path = require("path");
const {
  CODEX_PROFILE_ID,
  OPENCLAW_DIR,
  ALPHACLAW_DIR,
  kOnboardingMarkerPath,
} = require("./constants");
const { hasOpenclawConfig } = require("./openclaw-runtime-state");

const kDefaultAgentId = "main";
const kAuthProfileDatabaseFile = "openclaw-agent.sqlite";
const kAuthProfilePrimaryKey = "primary";
const kLegacyCodexAuthProvider = "openai-codex";
const kClaudeCliProfileId = "anthropic:claude-cli";
const kClaudeCliProviderId = "claude-cli";
const kInvalidAgentIdCharsRe = /[^a-z0-9_-]+/g;
const kLeadingDashRe = /^-+/;
const kTrailingDashRe = /-+$/;
const kApiKeyEnvVarByProvider = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  kilocode: "KILOCODE_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  volcengine: "VOLCANO_ENGINE_API_KEY",
  byteplus: "BYTEPLUS_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  minimax: "MINIMAX_API_KEY",
  voyage: "VOYAGE_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  vllm: "VLLM_API_KEY",
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

const credentialMode = (credential) => {
  if (credential.type === "api_key") return "api_key";
  if (credential.type === "token") return "token";
  return "oauth";
};

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

const resolvePendingAuthProfilesPath = (agentId = kDefaultAgentId) =>
  path.join(ALPHACLAW_DIR, "pending-auth-profiles", `${agentId}.json`);

const resolveAgentDir = (agentId = kDefaultAgentId) =>
  path.join(OPENCLAW_DIR, "agents", agentId, "agent");

const resolveAuthProfilesPath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "auth-profiles.json");

const resolveAuthProfileDatabasePath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), kAuthProfileDatabaseFile);

const resolveOpenclawConfigPath = () =>
  path.join(OPENCLAW_DIR, "openclaw.json");

const hasCompletedOnboardingConfig = (cfg) =>
  String(cfg?.agents?.defaults?.model?.primary || "").trim().includes("/");

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
  const normalizedAgentId = normalizeAgentId(agentId);
  const existingOwner = (() => {
    try {
      const schemaMeta = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
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
  db
    .prepare(
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
    )
    .run(kAuthProfilePrimaryKey, "agent", 1, normalizedAgentId, null, now, now);
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
      db
        .prepare(
          `
          INSERT INTO auth_profile_store (store_key, store_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(store_key) DO UPDATE SET
            store_json = excluded.store_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          kAuthProfilePrimaryKey,
          JSON.stringify({
            version: Number(store.version || 1),
            profiles: store.profiles || {},
          }),
          Date.now(),
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
        db
          .prepare(
            `
            INSERT INTO auth_profile_state (state_key, state_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(state_key) DO UPDATE SET
              state_json = excluded.state_json,
              updated_at = excluded.updated_at
          `,
          )
          .run(kAuthProfilePrimaryKey, JSON.stringify(statePayload), Date.now());
      } else {
        db
          .prepare("DELETE FROM auth_profile_state WHERE state_key = ?")
          .run(kAuthProfilePrimaryKey);
      }
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

const mergeAuthStores = (baseStore = { version: 1, profiles: {} }, overlayStore) => {
  if (!overlayStore) return baseStore;
  return {
    version: Number(
      overlayStore.version || baseStore.version || 1,
    ),
    profiles: {
      ...(baseStore.profiles || {}),
      ...(overlayStore.profiles || {}),
    },
    ...(baseStore.order !== undefined ? { order: baseStore.order } : {}),
    ...(baseStore.lastGood !== undefined ? { lastGood: baseStore.lastGood } : {}),
    ...(baseStore.usageStats !== undefined ? { usageStats: baseStore.usageStats } : {}),
    ...(overlayStore.order !== undefined ? { order: overlayStore.order } : {}),
    ...(overlayStore.lastGood !== undefined ? { lastGood: overlayStore.lastGood } : {}),
    ...(overlayStore.usageStats !== undefined
      ? { usageStats: overlayStore.usageStats }
      : {}),
  };
};

const loadAuthStore = (agentId = kDefaultAgentId) => {
  const store = { version: 1, profiles: {} };
  const pendingStore = readAuthStoreFile(resolvePendingAuthProfilesPath(agentId));
  if (!canPersistAuthStoreInOpenclaw()) {
    return mergeAuthStores(store, pendingStore);
  }

  const openclawDatabaseStore = readAuthStoreDatabase(agentId);
  const openclawStore = readAuthStoreFile(resolveAuthProfilesPath(agentId));
  return mergeAuthStores(
    mergeAuthStores(mergeAuthStores(store, openclawStore), openclawDatabaseStore),
    pendingStore,
  );
};

const saveAuthStore = (agentId, store) => {
  const pendingStorePath = resolvePendingAuthProfilesPath(agentId);
  const persistInOpenclaw = canPersistAuthStoreInOpenclaw();
  if (persistInOpenclaw) {
    const wroteDatabase = writeAuthStoreDatabase(agentId, store);
    if (wroteDatabase) {
      if (fs.existsSync(pendingStorePath)) {
        fs.rmSync(pendingStorePath, { force: true });
      }
      return;
    }
  }
  const storePath = persistInOpenclaw ? resolveAuthProfilesPath(agentId) : pendingStorePath;
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
  const configPath = resolveOpenclawConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
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

  const setAuthOrder = (provider, orderedProfileIds, agentId = kDefaultAgentId) => {
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
    for (const [profileId, credential] of Object.entries(store.profiles || {})) {
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

  const removeApiKeyProfileForEnvVar = (provider, agentId = kDefaultAgentId) => {
    const profileId = getDefaultProfileIdForApiKeyProvider(provider);
    if (!profileId) return false;
    const existing = getProfile(profileId, agentId);
    if (!existing) return false;
    if (existing.type !== "api_key" || existing.provider !== provider) return false;
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
    saveOpenclawConfig(cfg);
  };

  // ── Codex-specific wrappers ──

  const isCodexProfile = (profile) =>
    profile?.id === CODEX_PROFILE_ID ||
    profile?.provider === kLegacyCodexAuthProvider ||
    String(profile?.id || "").startsWith(`${kLegacyCodexAuthProvider}:`);

  const listCodexProfiles = () =>
    listProfiles().filter(
      (profile) =>
        isCodexProfile(profile) ||
        (profile.provider === "openai" && profile.type === "oauth"),
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
      ...existingAnthropicOrder.filter((entry) => entry !== kClaudeCliProfileId),
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
        ...existingAnthropicOrder.filter((entry) => entry !== kClaudeCliProfileId),
      ]);
      saveOpenclawConfig(cfg);
    }
  };

  const upsertCodexProfile = ({ access, refresh, expires, accountId }) => {
    upsertProfile(CODEX_PROFILE_ID, {
      type: "oauth",
      provider: "openai",
      access,
      refresh,
      expires,
      updatedAt: Date.now(),
      ...(accountId ? { accountId } : {}),
    });
    const store = loadAuthStore(kDefaultAgentId);
    const existingOpenAiOrder = Array.isArray(store.order?.openai)
      ? store.order.openai
      : [];
    setAuthOrder("openai", [
      CODEX_PROFILE_ID,
      ...existingOpenAiOrder.filter((entry) => entry !== CODEX_PROFILE_ID),
    ]);
  };

  const removeCodexProfiles = () => {
    const store = loadAuthStore();
    let changed = false;
    for (const [id, cred] of Object.entries(store.profiles || {})) {
      if (
        id === CODEX_PROFILE_ID ||
        cred?.provider === kLegacyCodexAuthProvider ||
        id.startsWith(`${kLegacyCodexAuthProvider}:`)
      ) {
        delete store.profiles[id];
        changed = true;
      }
    }
    if (changed) {
      if (store.order?.openai) {
        store.order.openai = store.order.openai.filter((id) => id !== CODEX_PROFILE_ID);
        if (store.order.openai.length === 0) {
          delete store.order.openai;
        }
      }
      saveAuthStore(kDefaultAgentId, store);
      if (!canSyncOpenclawAuthReferences()) return changed;
      let cfg = loadOpenclawConfig();
      for (const [id, cred] of Object.entries(cfg.auth?.profiles || {})) {
        if (
          id === CODEX_PROFILE_ID ||
          cred?.provider === kLegacyCodexAuthProvider ||
          id.startsWith(`${kLegacyCodexAuthProvider}:`)
        ) {
          cfg = removeConfigAuthReference(cfg, id);
        }
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
