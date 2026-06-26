const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const kAuthProfileFileName = "auth-profiles.json";
const kAuthProfileDatabaseName = "openclaw-agent.sqlite";
const kPrimaryStoreKey = "primary";
const kShieldDurationMs = 7 * 24 * 60 * 60 * 1000;

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const canonicalProvider = (provider) =>
  provider === "openai-codex" ? "openai" : provider;

const canonicalProfileId = (profileId) => {
  if (profileId.startsWith("openai-codex:")) {
    return `openai:${profileId.slice("openai-codex:".length)}`;
  }
  return profileId;
};

const readJsonFile = ({ fsModule = fs, filePath }) => {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const writeJsonFile = ({ fsModule = fs, filePath, value }) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const loadNodeSqlite = () => {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
};

const withAuthProfileDatabase = ({ sqliteModule, databasePath, readOnly = false }, callback) => {
  if (!fs.existsSync(databasePath)) return null;
  const sqlite = sqliteModule || loadNodeSqlite();
  if (!sqlite) return null;
  const db = new sqlite.DatabaseSync(databasePath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return callback(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
};

const readSqliteStore = ({ sqliteModule, databasePath }) =>
  withAuthProfileDatabase({ sqliteModule, databasePath, readOnly: true }, (db) => {
    const row = db
      .prepare(
        "SELECT store_json FROM auth_profile_store WHERE store_key = ? LIMIT 1",
      )
      .get(kPrimaryStoreKey);
    if (!row?.store_json) return null;
    return JSON.parse(row.store_json);
  });

const writeSqliteStore = ({ sqliteModule, databasePath, store }) =>
  withAuthProfileDatabase({ sqliteModule, databasePath, readOnly: false }, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
      INSERT INTO auth_profile_store (store_key, store_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(store_key) DO UPDATE SET
        store_json = excluded.store_json,
        updated_at = excluded.updated_at
    `,
    ).run(kPrimaryStoreKey, JSON.stringify(store), Date.now());
    return true;
  }) === true;

const findAgentDirs = ({ fsModule = fs, openclawDir }) => {
  const dirs = new Set();
  const addDir = (dir) => {
    if (dir && fsModule.existsSync(dir)) dirs.add(dir);
  };

  addDir(openclawDir);
  addDir(path.join(openclawDir, "agent"));

  const agentsRoot = path.join(openclawDir, "agents");
  if (fsModule.existsSync(agentsRoot)) {
    for (const agentId of fsModule.readdirSync(agentsRoot)) {
      addDir(path.join(agentsRoot, agentId, "agent"));
    }
  }

  return [...dirs].sort();
};

const collectOAuthProfiles = (store) => {
  if (!isObject(store?.profiles)) return [];
  return Object.entries(store.profiles)
    .filter(([, credential]) => isObject(credential) && credential.type === "oauth")
    .map(([profileId, credential]) => ({
      profileId,
      canonicalProfileId: canonicalProfileId(profileId),
      provider: canonicalProvider(credential.provider || ""),
      credential: cloneJson(credential),
    }));
};

const shieldOAuthExpiries = ({ store, shieldExpiresAt }) => {
  if (!isObject(store?.profiles)) {
    return { store, changed: false, shielded: 0 };
  }
  let changed = false;
  let shielded = 0;
  const next = cloneJson(store);
  for (const credential of Object.values(next.profiles)) {
    if (!isObject(credential) || credential.type !== "oauth") continue;
    if (
      typeof credential.access !== "string" ||
      !credential.access.trim() ||
      typeof credential.refresh !== "string" ||
      !credential.refresh.trim()
    ) {
      continue;
    }
    shielded += 1;
    if (typeof credential.expires !== "number" || credential.expires < shieldExpiresAt) {
      credential.expires = shieldExpiresAt;
      changed = true;
    }
  }
  return { store: next, changed, shielded };
};

const findOriginalForProfile = ({ profileId, credential, originals }) => {
  const exact = originals.find((entry) => entry.profileId === profileId);
  if (exact) return exact;

  const canonicalId = canonicalProfileId(profileId);
  const byCanonicalId = originals.find((entry) => entry.canonicalProfileId === canonicalId);
  if (byCanonicalId) return byCanonicalId;

  const provider = canonicalProvider(credential.provider || "");
  return originals.find((entry) => {
    if (entry.provider !== provider) return false;
    if (credential.email && entry.credential.email === credential.email) return true;
    if (credential.accountId && entry.credential.accountId === credential.accountId) return true;
    return false;
  });
};

const mergeOAuthCredentialMaterial = ({ finalCredential, originalCredential }) => ({
  ...finalCredential,
  access: originalCredential.access,
  refresh: originalCredential.refresh,
  expires: originalCredential.expires,
  ...(originalCredential.idToken !== undefined ? { idToken: originalCredential.idToken } : {}),
  ...(originalCredential.clientId !== undefined ? { clientId: originalCredential.clientId } : {}),
  ...(originalCredential.email !== undefined ? { email: originalCredential.email } : {}),
  ...(originalCredential.enterpriseUrl !== undefined
    ? { enterpriseUrl: originalCredential.enterpriseUrl }
    : {}),
  ...(originalCredential.projectId !== undefined ? { projectId: originalCredential.projectId } : {}),
  ...(originalCredential.accountId !== undefined ? { accountId: originalCredential.accountId } : {}),
  ...(originalCredential.chatgptPlanType !== undefined
    ? { chatgptPlanType: originalCredential.chatgptPlanType }
    : {}),
  ...(originalCredential.displayName !== undefined
    ? { displayName: originalCredential.displayName }
    : {}),
  ...(originalCredential.copyToAgents !== undefined
    ? { copyToAgents: originalCredential.copyToAgents }
    : {}),
});

const restoreOAuthCredentialMaterial = ({ store, originals }) => {
  if (!isObject(store)) return { store, changed: false, restored: 0 };
  const next = cloneJson(store);
  if (!isObject(next.profiles)) next.profiles = {};

  let changed = false;
  let restored = 0;
  const restoredOriginalIds = new Set();

  for (const [profileId, credential] of Object.entries(next.profiles)) {
    if (!isObject(credential) || credential.type !== "oauth") continue;
    const original = findOriginalForProfile({ profileId, credential, originals });
    if (!original) continue;
    next.profiles[profileId] = mergeOAuthCredentialMaterial({
      finalCredential: credential,
      originalCredential: original.credential,
    });
    restoredOriginalIds.add(original.profileId);
    restored += 1;
    changed = true;
  }

  for (const original of originals) {
    if (restoredOriginalIds.has(original.profileId)) continue;
    const targetProfileId = original.canonicalProfileId;
    if (isObject(next.profiles[targetProfileId])) continue;
    next.profiles[targetProfileId] = {
      ...cloneJson(original.credential),
      provider: canonicalProvider(original.credential.provider || original.provider),
    };
    restored += 1;
    changed = true;
  }

  return { store: next, changed, restored };
};

const collectAuthStoreSnapshots = ({
  fsModule = fs,
  sqliteModule,
  openclawDir,
  now = Date.now(),
}) => {
  const shieldExpiresAt = now + kShieldDurationMs;
  const snapshots = [];
  let totalShielded = 0;
  let totalChangedStores = 0;

  for (const agentDir of findAgentDirs({ fsModule, openclawDir })) {
    const jsonPath = path.join(agentDir, kAuthProfileFileName);
    const sqlitePath = path.join(agentDir, kAuthProfileDatabaseName);
    const sources = [];

    if (fsModule.existsSync(jsonPath)) {
      const store = readJsonFile({ fsModule, filePath: jsonPath });
      const originals = collectOAuthProfiles(store);
      const shield = shieldOAuthExpiries({ store, shieldExpiresAt });
      if (originals.length > 0 || shield.shielded > 0) {
        sources.push({ type: "json", path: jsonPath, store, originals });
      }
      if (shield.changed) {
        writeJsonFile({ fsModule, filePath: jsonPath, value: shield.store });
        totalChangedStores += 1;
      }
      totalShielded += shield.shielded;
    }

    const sqliteStore = readSqliteStore({ sqliteModule, databasePath: sqlitePath });
    if (sqliteStore) {
      const originals = collectOAuthProfiles(sqliteStore);
      const shield = shieldOAuthExpiries({ store: sqliteStore, shieldExpiresAt });
      if (originals.length > 0 || shield.shielded > 0) {
        sources.push({ type: "sqlite", path: sqlitePath, store: sqliteStore, originals });
      }
      if (shield.changed) {
        writeSqliteStore({ sqliteModule, databasePath: sqlitePath, store: shield.store });
        totalChangedStores += 1;
      }
      totalShielded += shield.shielded;
    }

    if (sources.length > 0) {
      snapshots.push({ agentDir, jsonPath, sqlitePath, sources });
    }
  }

  return {
    snapshots,
    summary: {
      shieldedProfiles: totalShielded,
      changedStores: totalChangedStores,
    },
  };
};

const restoreAuthStoreSnapshots = ({ fsModule = fs, sqliteModule, snapshots }) => {
  let restoredProfiles = 0;
  let changedStores = 0;

  for (const snapshot of snapshots) {
    const allOriginals = snapshot.sources.flatMap((source) => source.originals);
    if (allOriginals.length === 0) continue;
    const originalsForSource = (type) => {
      const source = snapshot.sources.find((entry) => entry.type === type);
      return source?.originals?.length ? source.originals : allOriginals;
    };

    const sqliteStore = readSqliteStore({
      sqliteModule,
      databasePath: snapshot.sqlitePath,
    });
    if (sqliteStore) {
      const result = restoreOAuthCredentialMaterial({
        store: sqliteStore,
        originals: originalsForSource("sqlite"),
      });
      if (result.changed) {
        writeSqliteStore({
          sqliteModule,
          databasePath: snapshot.sqlitePath,
          store: result.store,
        });
        changedStores += 1;
      }
      restoredProfiles += result.restored;
    }

    if (fsModule.existsSync(snapshot.jsonPath)) {
      const jsonStore = readJsonFile({ fsModule, filePath: snapshot.jsonPath });
      const result = restoreOAuthCredentialMaterial({
        store: jsonStore,
        originals: originalsForSource("json"),
      });
      if (result.changed) {
        writeJsonFile({ fsModule, filePath: snapshot.jsonPath, value: result.store });
        changedStores += 1;
      }
      restoredProfiles += result.restored;
    }
  }

  return { restoredProfiles, changedStores };
};

const runOpenclawDoctorWithOauthGuard = ({
  fsModule = fs,
  sqliteModule,
  rootDir,
  openclawDir = path.join(rootDir, ".openclaw"),
  commandArgs,
  env = process.env,
  cwd = process.cwd(),
  stdio = "inherit",
  logger = console,
} = {}) => {
  if (!rootDir) throw new Error("rootDir is required");
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error("commandArgs are required");
  }

  logger.log("[alphaclaw] Shielding OAuth auth profiles before OpenClaw doctor");
  const shieldResult = collectAuthStoreSnapshots({
    fsModule,
    sqliteModule,
    openclawDir,
  });
  logger.log(
    `[alphaclaw] Shielded ${shieldResult.summary.shieldedProfiles} OAuth profile(s) across ${shieldResult.summary.changedStores} auth store(s)`,
  );

  let commandStatus = 0;
  let commandError = null;
  let restoreError = null;
  try {
    const commandResult = spawnSync(commandArgs[0], commandArgs.slice(1), {
      cwd,
      env,
      stdio,
    });
    commandStatus = commandResult.status ?? (commandResult.signal ? 1 : commandResult.error ? 1 : 0);
    commandError = commandResult.error || null;
  } finally {
    try {
      const restoreResult = restoreAuthStoreSnapshots({
        fsModule,
        sqliteModule,
        snapshots: shieldResult.snapshots,
      });
      logger.log(
        `[alphaclaw] Restored ${restoreResult.restoredProfiles} OAuth profile(s) after OpenClaw doctor`,
      );
    } catch (error) {
      restoreError = error;
      logger.error(
        `[alphaclaw] Failed to restore OAuth auth profiles after OpenClaw doctor: ${error.message || error}`,
      );
    }
  }
  if (restoreError) return 1;
  if (commandError) {
    logger.error(`[alphaclaw] OpenClaw doctor command failed: ${commandError.message}`);
  }
  return commandStatus;
};

module.exports = {
  canonicalProfileId,
  collectAuthStoreSnapshots,
  collectOAuthProfiles,
  restoreAuthStoreSnapshots,
  restoreOAuthCredentialMaterial,
  runOpenclawDoctorWithOauthGuard,
  shieldOAuthExpiries,
};
