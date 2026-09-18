const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { isBrokeredCodexCredential } = require("../oauth-broker-constants");

const kAuthProfileFileName = "auth-profiles.json";
const kAuthProfileDatabaseName = "openclaw-agent.sqlite";
const kPrimaryStoreKey = "primary";
const kSharedAuthOwnershipStateKey = "auth.sharedStore";
const kSharedAuthStoreStateKey = "authProfiles.store";
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

const oauthLockPathDigest = (value) => {
  let left = 0xcbf29ce484222325n;
  let right = 0x9ae16a3b2f90404fn;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(value, "utf8")) {
    const octet = BigInt(byte);
    left = ((left ^ octet) * prime) & mask;
    right = ((right ^ (octet + 0x9e3779b97f4a7c15n)) * prime) & mask;
  }
  return `${left.toString(16).padStart(16, "0")}${right
    .toString(16)
    .padStart(16, "0")}`;
};

const getFileLockProcessStartTime = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commEndIndex = stat.lastIndexOf(")");
      if (commEndIndex < 0) return null;
      const fields = stat.slice(commEndIndex + 1).trimStart().split(/\s+/);
      const starttime = Number(fields[19]);
      return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    const startedAtMs = Date.parse(`${String(result.stdout || "").trim()} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
  }
  return null;
};

const isPidDefinitelyDead = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};

const isLockOwnerDefinitelyStale = (payload) => {
  const pid = Number(payload?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (Number.isInteger(payload?.starttime) && payload.starttime >= 0) {
    const observed = getFileLockProcessStartTime(pid);
    const recorded =
      process.platform === "darwin" && payload.starttime > 10_000_000_000
        ? Math.floor(payload.starttime / 1_000_000)
        : payload.starttime;
    if (observed !== null && observed !== recorded) return true;
  }
  return isPidDefinitelyDead(pid);
};

const sameFileIdentity = (left, right) =>
  left?.isFile?.() &&
  right?.isFile?.() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs;

const removeDefinitelyStaleLock = ({ fsModule = fs, lockPath }) => {
  let observed;
  let payload;
  try {
    observed = fsModule.lstatSync(lockPath, { bigint: true });
    if (!observed.isFile()) return false;
    payload = JSON.parse(fsModule.readFileSync(lockPath, "utf8"));
  } catch {
    return false;
  }
  if (!isLockOwnerDefinitelyStale(payload)) return false;
  try {
    const current = fsModule.lstatSync(lockPath, { bigint: true });
    if (!sameFileIdentity(observed, current)) return false;
    fsModule.rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
};

const acquireOAuthProfileLocks = ({ fsModule = fs, openclawDir, profiles }) => {
  const lockDir = path.join(openclawDir, "locks", "oauth-refresh");
  const locks = [];
  const keys = [
    ...new Map(
      profiles.map((profile) => [
        JSON.stringify([profile.provider, profile.canonicalProfileId]),
        { provider: profile.provider, profileId: profile.canonicalProfileId },
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.profileId.localeCompare(right.profileId),
  );
  fsModule.mkdirSync(lockDir, { recursive: true });
  try {
    for (const key of keys) {
      const targetPath = path.join(
        lockDir,
        `lock-${oauthLockPathDigest(
          JSON.stringify([key.provider, key.profileId]),
        )}`,
      );
      const lockPath = `${targetPath}.lock`;
      const lockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const starttime = getFileLockProcessStartTime(process.pid);
      if (starttime !== null) lockPayload.starttime = starttime;
      try {
        fsModule.writeFileSync(lockPath, JSON.stringify(lockPayload), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (
          error?.code !== "EEXIST" ||
          !removeDefinitelyStaleLock({ fsModule, lockPath })
        ) {
          throw error;
        }
        fsModule.writeFileSync(lockPath, JSON.stringify(lockPayload), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      locks.push(lockPath);
    }
    return locks;
  } catch (error) {
    for (const lockPath of locks.reverse()) {
      fsModule.rmSync(lockPath, { force: true });
    }
    if (error?.code === "EEXIST") {
      const wrapped = new Error(
        "An OAuth profile is currently being refreshed; retry OpenClaw doctor after the refresh completes.",
      );
      wrapped.code = "oauth_refresh_lock_busy";
      throw wrapped;
    }
    throw error;
  }
};

const releaseOAuthProfileLocks = ({ fsModule = fs, locks = [] }) => {
  for (const lockPath of [...locks].reverse()) {
    fsModule.rmSync(lockPath, { force: true });
  }
};

const withAuthProfileDatabase = (
  {
    fsModule = fs,
    sqliteModule,
    databasePath,
    readOnly = false,
    strict = false,
  },
  callback,
) => {
  if (!fsModule.existsSync(databasePath)) return null;
  const sqlite = sqliteModule || loadNodeSqlite();
  if (!sqlite) return null;
  const db = new sqlite.DatabaseSync(databasePath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return callback(db);
  } catch (error) {
    if (strict) throw error;
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

const readSharedStateStore = ({ fsModule = fs, sqliteModule, openclawDir }) => {
  const databasePath = path.join(openclawDir, "state", "openclaw.sqlite");
  if (!fsModule.existsSync(databasePath)) return null;
  const result = withAuthProfileDatabase(
    { fsModule, sqliteModule, databasePath, readOnly: true, strict: true },
    (db) => {
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'",
        )
        .get();
      if (!table) return null;
      const ownershipRow = db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = ?",
        )
        .get(kSharedAuthOwnershipStateKey);
      if (!ownershipRow?.value_json) return null;
      const ownership = JSON.parse(ownershipRow.value_json);
      if (ownership?.location !== "state-db") return null;
      const storeRow = db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = ?",
        )
        .get(kSharedAuthStoreStateKey);
      return storeRow?.value_json
        ? { store: JSON.parse(storeRow.value_json) }
        : null;
    },
  );
  return result ? { databasePath, store: result.store } : null;
};

const writeSharedStateStore = ({ sqliteModule, databasePath, store }) =>
  withAuthProfileDatabase(
    { sqliteModule, databasePath, readOnly: false },
    (db) => {
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'",
        )
        .get();
      if (!table) return false;
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(
          `
            INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(state_key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at_ms = excluded.updated_at_ms
          `,
        ).run(kSharedAuthStoreStateKey, JSON.stringify(store), Date.now());
        db.exec("COMMIT;");
        return true;
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {}
        throw error;
      }
    },
  ) === true;

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
    .filter(
      ([, credential]) =>
        isObject(credential) &&
        credential.type === "oauth" &&
        !isBrokeredCodexCredential(credential),
    )
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
    if (isBrokeredCodexCredential(credential)) continue;
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
    if (isBrokeredCodexCredential(credential)) continue;
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

const readAuthStoreSnapshots = ({
  fsModule = fs,
  sqliteModule,
  openclawDir,
  now = Date.now(),
}) => {
  const shieldExpiresAt = now + kShieldDurationMs;
  const snapshots = [];

  const sharedState = openclawDir
    ? readSharedStateStore({ fsModule, sqliteModule, openclawDir })
    : null;
  if (sharedState) {
    const originals = collectOAuthProfiles(sharedState.store);
    const shield = shieldOAuthExpiries({
      store: sharedState.store,
      shieldExpiresAt,
    });
    if (originals.length > 0 || shield.shielded > 0) {
      snapshots.push({
        agentDir: null,
        jsonPath: null,
        sqlitePath: null,
        sources: [
          {
            type: "shared-state",
            path: sharedState.databasePath,
            store: sharedState.store,
            originals,
            shield,
          },
        ],
      });
    }
  }

  for (const agentDir of findAgentDirs({ fsModule, openclawDir })) {
    const jsonPath = path.join(agentDir, kAuthProfileFileName);
    const sqlitePath = path.join(agentDir, kAuthProfileDatabaseName);
    const sources = [];

    if (fsModule.existsSync(jsonPath)) {
      const store = readJsonFile({ fsModule, filePath: jsonPath });
      const originals = collectOAuthProfiles(store);
      const shield = shieldOAuthExpiries({ store, shieldExpiresAt });
      if (originals.length > 0 || shield.shielded > 0) {
        sources.push({
          type: "json",
          path: jsonPath,
          store,
          originals,
          shield,
        });
      }
    }

    const sqliteStore = readSqliteStore({ sqliteModule, databasePath: sqlitePath });
    if (sqliteStore) {
      const originals = collectOAuthProfiles(sqliteStore);
      const shield = shieldOAuthExpiries({ store: sqliteStore, shieldExpiresAt });
      if (originals.length > 0 || shield.shielded > 0) {
        sources.push({
          type: "sqlite",
          path: sqlitePath,
          store: sqliteStore,
          originals,
          shield,
        });
      }
    }

    if (sources.length > 0) {
      snapshots.push({ agentDir, jsonPath, sqlitePath, sources });
    }
  }

  return snapshots;
};

const collectAuthStoreSnapshots = ({
  fsModule = fs,
  sqliteModule,
  openclawDir,
  now = Date.now(),
}) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const initialSnapshots = readAuthStoreSnapshots({
      fsModule,
      sqliteModule,
      openclawDir,
      now,
    });
    const initialProfiles = initialSnapshots
      .flatMap((snapshot) => snapshot.sources)
      .flatMap((source) => source.originals);
    const requestedLockKeys = new Set(
      initialProfiles.map((profile) =>
        JSON.stringify([profile.provider, profile.canonicalProfileId]),
      ),
    );
    const locks = acquireOAuthProfileLocks({
      fsModule,
      openclawDir,
      profiles: initialProfiles,
    });
    let locksHeld = true;
    const releaseLocks = () => {
      if (!locksHeld) return;
      releaseOAuthProfileLocks({ fsModule, locks });
      locksHeld = false;
    };
    try {
      // Re-read every store only after all known profile locks are held. If a
      // new profile appeared during acquisition, release and retry so it is
      // never shielded from an unlocked, stale snapshot.
      const snapshots = readAuthStoreSnapshots({
        fsModule,
        sqliteModule,
        openclawDir,
        now,
      });
      const allSources = snapshots.flatMap((snapshot) => snapshot.sources);
      const observedProfiles = allSources.flatMap((source) => source.originals);
      const hasUnlockedProfile = observedProfiles.some(
        (profile) =>
          !requestedLockKeys.has(
            JSON.stringify([profile.provider, profile.canonicalProfileId]),
          ),
      );
      if (hasUnlockedProfile) {
        releaseLocks();
        if (attempt < 2) continue;
        const error = new Error(
          "OAuth profile inventory changed while acquiring refresh locks; retry OpenClaw doctor after credential activity settles.",
        );
        error.code = "oauth_refresh_inventory_changed";
        throw error;
      }

      let totalChangedStores = 0;
      for (const source of allSources) {
        if (!source.shield.changed) continue;
        if (source.type === "json") {
          writeJsonFile({
            fsModule,
            filePath: source.path,
            value: source.shield.store,
          });
        } else if (source.type === "sqlite") {
          const wrote = writeSqliteStore({
            sqliteModule,
            databasePath: source.path,
            store: source.shield.store,
          });
          if (!wrote) {
            throw new Error(`Failed to shield OAuth profiles in ${source.path}`);
          }
        } else {
          const wrote = writeSharedStateStore({
            sqliteModule,
            databasePath: source.path,
            store: source.shield.store,
          });
          if (!wrote) {
            throw new Error(`Failed to shield OAuth profiles in ${source.path}`);
          }
        }
        totalChangedStores += 1;
      }

      return {
        locks,
        snapshots,
        summary: {
          shieldedProfiles: allSources.reduce(
            (total, source) => total + source.shield.shielded,
            0,
          ),
          changedStores: totalChangedStores,
        },
      };
    } catch (error) {
      releaseLocks();
      throw error;
    }
  }
  throw new Error("Could not acquire a stable OAuth profile inventory");
};

const restoreAuthStoreSnapshots = ({
  fsModule = fs,
  sqliteModule,
  openclawDir,
  snapshots,
}) => {
  let restoredProfiles = 0;
  let changedStores = 0;

  const sharedSnapshot = snapshots.find((snapshot) =>
    snapshot.sources.some((source) => source.type === "shared-state"),
  );
  const sharedState = openclawDir
    ? readSharedStateStore({ fsModule, sqliteModule, openclawDir })
    : null;
  if (sharedSnapshot && !sharedState) {
    throw new Error(
      "Failed to reopen the shared OAuth store after OpenClaw doctor",
    );
  }
  if (sharedState) {
    const legacyMainDir = path.join(openclawDir, "agents", "main", "agent");
    const legacyMainSnapshot = snapshots.find(
      (snapshot) => snapshot.agentDir === legacyMainDir,
    );
    const originals = (sharedSnapshot || legacyMainSnapshot)?.sources.flatMap(
      (source) => source.originals,
    );
    if (originals?.length) {
      const result = restoreOAuthCredentialMaterial({
        store: sharedState.store,
        originals,
      });
      if (result.changed) {
        const wrote = writeSharedStateStore({
          sqliteModule,
          databasePath: sharedState.databasePath,
          store: result.store,
        });
        if (!wrote) {
          throw new Error(
            `Failed to restore OAuth profiles in ${sharedState.databasePath}`,
          );
        }
        changedStores += 1;
      }
      restoredProfiles += result.restored;
    }
  }

  for (const snapshot of snapshots) {
    if (
      snapshot.sources.some((source) => source.type === "shared-state") ||
      (sharedState &&
        snapshot.agentDir === path.join(openclawDir, "agents", "main", "agent"))
    ) {
      continue;
    }
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
        const wrote = writeSqliteStore({
          sqliteModule,
          databasePath: snapshot.sqlitePath,
          store: result.store,
        });
        if (!wrote) {
          throw new Error(
            `Failed to restore OAuth profiles in ${snapshot.sqlitePath}`,
          );
        }
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
        openclawDir,
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
    } finally {
      releaseOAuthProfileLocks({
        fsModule,
        locks: shieldResult.locks,
      });
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
  acquireOAuthProfileLocks,
  collectAuthStoreSnapshots,
  collectOAuthProfiles,
  restoreAuthStoreSnapshots,
  restoreOAuthCredentialMaterial,
  runOpenclawDoctorWithOauthGuard,
  shieldOAuthExpiries,
};
