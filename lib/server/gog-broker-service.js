const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  GOG_BROKER_CONSUMERS,
  isGogBrokerConsumer,
} = require("../oauth-broker-constants");
const {
  getGoogleAccountById,
  removeGoogleAccount,
  upsertGoogleAccount,
} = require("./google-state");
const { quoteShellArg } = require("./utils/shell");

const kMinimumAccessLifetimeMs = 5 * 60 * 1000;
const kRevocationRetryDelaysMs = [5, 15, 30, 60].map(
  (seconds) => seconds * 1000,
);

const safeErrorCode = (error) => {
  const code = String(error?.code || "broker_unavailable");
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "broker_unavailable";
};

const secretHash = (value) =>
  crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");

const fsyncDirectory = (fsModule, directoryPath) => {
  const descriptor = fsModule.openSync(directoryPath, "r");
  try {
    fsModule.fsyncSync(descriptor);
  } finally {
    fsModule.closeSync(descriptor);
  }
};

const writeJsonAtomically = (fsModule, filePath, value) => {
  const directoryPath = path.dirname(filePath);
  fsModule.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp.${process.pid}.${crypto
    .randomBytes(8)
    .toString("hex")}`;
  try {
    const descriptor = fsModule.openSync(temporaryPath, "wx", 0o600);
    try {
      fsModule.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsModule.fsyncSync(descriptor);
    } finally {
      fsModule.closeSync(descriptor);
    }
    fsModule.renameSync(temporaryPath, filePath);
    fsyncDirectory(fsModule, directoryPath);
  } catch (error) {
    fsModule.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const readMarker = (fsModule, markerPath) => {
  try {
    const marker = JSON.parse(fsModule.readFileSync(markerPath, "utf8"));
    return marker?.schemaVersion === 1 ? marker : null;
  } catch {
    return null;
  }
};

const clearMarker = (fsModule, markerPath) => {
  fsModule.rmSync(markerPath, { force: true });
  const directoryPath = path.dirname(markerPath);
  if (fsModule.existsSync(directoryPath)) fsyncDirectory(fsModule, directoryPath);
};

const clientArg = (client) =>
  client && client !== "default" ? `--client ${quoteShellArg(client)} ` : "";

const createGogBrokerService = ({
  brokerClient,
  gogCmd,
  readState,
  saveState,
  readGoogleCredentials,
  gogClientCredentialsPath,
  resolveOAuthScopes,
  markerDir,
  migrationTempDir = "/dev/shm",
  maxAccounts = 5,
  fsModule = fs,
  isManagedInstance = () => false,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  revocationRetryDelaysMs = kRevocationRetryDelaysMs,
  logger = console,
} = {}) => {
  if (
    !brokerClient ||
    !gogCmd ||
    !readState ||
    !saveState ||
    !readGoogleCredentials ||
    !gogClientCredentialsPath ||
    !resolveOAuthScopes ||
    !markerDir
  ) {
    throw new Error("gog broker service dependencies are incomplete");
  }

  let lifecycleTail = Promise.resolve();
  let started = false;
  let retryTimer = null;
  let retryAttempt = 0;

  const withLifecycleLock = (operation) => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.catch(() => {});
    return run;
  };

  const isBrokeredMode = () =>
    brokerClient.isConfigured() || isManagedInstance();

  const depositMarkerPath = (consumer) =>
    path.join(markerDir, `${consumer}-deposit-pending.json`);
  const revocationMarkerPath = (consumer) =>
    path.join(markerDir, `${consumer}-revocation-pending.json`);

  const writeMarker = (markerPath, marker) =>
    writeJsonAtomically(fsModule, markerPath, {
      schemaVersion: 1,
      updatedAt: now(),
      ...marker,
    });

  const allocateConsumer = (state, preferred = "") => {
    if (isGogBrokerConsumer(preferred)) return preferred;
    const used = new Set(
      (state.accounts || [])
        .map((account) => account.brokerConsumer)
        .filter(isGogBrokerConsumer),
    );
    const available = GOG_BROKER_CONSUMERS.find((consumer) => !used.has(consumer));
    if (!available) {
      const error = new Error("No Google OAuth broker account slots are available");
      error.code = "gog_slots_exhausted";
      throw error;
    }
    return available;
  };

  const validateLease = (response) => {
    if (response.expires_at * 1000 <= now() + kMinimumAccessLifetimeMs) {
      const error = new Error("Google OAuth broker returned an expiring access token");
      error.code = "invalid_response";
      throw error;
    }
    return response;
  };

  const removeLocalToken = async (account) => {
    const email = String(account?.email || "").trim();
    if (!email) return;
    const result = await gogCmd(
      `${clientArg(account.client)}auth remove ${quoteShellArg(email)} --force`,
      { quiet: true, authBypass: true },
    );
    if (!result.ok) {
      const error = new Error("Failed to remove the local gog refresh grant");
      error.code = "gog_token_cleanup_failed";
      throw error;
    }
  };

  const removeUnusedClientCredential = async (account, state) => {
    const client = String(account?.client || "default") || "default";
    const stillNeeded = (state.accounts || []).some(
      (candidate) =>
        candidate.client === client && !isGogBrokerConsumer(candidate.brokerConsumer),
    );
    if (!stillNeeded) {
      const credentialPath = gogClientCredentialsPath(client);
      const result = await gogCmd(
        `auth credentials remove ${quoteShellArg(client)} --force`,
        { quiet: true, authBypass: true },
      );
      if (!result.ok && fsModule.existsSync(credentialPath)) {
        const error = new Error("Failed to remove local gog client credentials");
        error.code = "gog_credentials_cleanup_failed";
        throw error;
      }
      fsModule.rmSync(credentialPath, { force: true });
    }
  };

  const finalizeDepositedMarker = async (markerPath, marker) => {
    validateLease(
      await brokerClient.getGogAccessToken({ consumer: marker.consumer }),
    );
    const currentState = readState();
    const current = getGoogleAccountById(currentState, marker.account.id);
    const account = {
      ...marker.account,
      ...(current || {}),
      authenticated: true,
      brokerConsumer: marker.consumer,
    };
    const { state: nextState } = upsertGoogleAccount({
      state: currentState,
      account,
      maxAccounts,
    });
    saveState(nextState);
    await removeLocalToken(account);
    await removeUnusedClientCredential(account, nextState);
    clearMarker(fsModule, markerPath);
    return { brokered: true, consumer: marker.consumer, account };
  };

  const reconcileDepositsUnlocked = async () => {
    fsModule.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const names = fsModule
      .readdirSync(markerDir)
      .filter((name) => /^gog-[1-5]-deposit-pending\.json$/.test(name));
    const results = [];
    for (const name of names) {
      const markerPath = path.join(markerDir, name);
      const marker = readMarker(fsModule, markerPath);
      if (
        !marker ||
        !isGogBrokerConsumer(marker.consumer) ||
        !["prepared", "deposited"].includes(marker.phase) ||
        !marker.account?.id
      ) {
        results.push({ pending: true, error: "deposit_journal_invalid" });
        continue;
      }
      try {
        if (marker.phase === "prepared") {
          await brokerClient.revokeGogGrant({ consumer: marker.consumer });
          const state = readState();
          const current = getGoogleAccountById(state, marker.account.id);
          if (current?.brokerConsumer === marker.consumer) {
            const { state: nextState } = upsertGoogleAccount({
              state,
              account: {
                ...current,
                authenticated: false,
                brokerConsumer: "",
              },
              maxAccounts,
            });
            saveState(nextState);
          }
          clearMarker(fsModule, markerPath);
          results.push({ pending: false, revoked: true });
        } else {
          await finalizeDepositedMarker(markerPath, marker);
          results.push({ pending: false, committed: true });
        }
      } catch (error) {
        logger.error(
          `[alphaclaw] gog OAuth deposit recovery failed (${safeErrorCode(error)})`,
        );
        results.push({ pending: true, error: safeErrorCode(error) });
      }
    }
    return results;
  };

  const adoptGrantUnlocked = async ({
    account,
    clientId,
    clientSecret,
    refreshToken,
    scopes,
  }) => {
    if (!brokerClient.isConfigured()) {
      if (!isManagedInstance()) return { brokered: false, account };
      const error = new Error(
        "OAuth credential broker is unavailable on this managed instance",
      );
      error.code = "not_configured";
      throw error;
    }
    const normalizedRefresh = String(refreshToken || "").trim();
    if (!normalizedRefresh) {
      const error = new Error("Google OAuth refresh token is missing");
      error.code = "google_refresh_missing";
      throw error;
    }
    const revocations = await retryRevocationsUnlocked();
    if (revocations.some((result) => result.pending)) {
      const error = new Error("A previous Google OAuth revocation is pending");
      error.code = "revocation_pending";
      throw error;
    }
    const deposits = await reconcileDepositsUnlocked();
    if (deposits.some((result) => result.pending)) {
      const error = new Error("A previous Google OAuth deposit is pending");
      error.code = "deposit_pending";
      throw error;
    }
    const state = readState();
    const consumer = allocateConsumer(state, account.brokerConsumer);
    const markerPath = depositMarkerPath(consumer);
    const marker = {
      phase: "prepared",
      consumer,
      refreshSha256: secretHash(normalizedRefresh),
      account: {
        ...account,
        authenticated: false,
        brokerConsumer: "",
      },
    };
    writeMarker(markerPath, marker);
    await brokerClient.depositGogGrant({
      consumer,
      clientId,
      clientSecret,
      refreshToken: normalizedRefresh,
      scopes,
    });
    writeMarker(markerPath, { ...marker, phase: "deposited" });
    return await finalizeDepositedMarker(markerPath, {
      ...marker,
      phase: "deposited",
    });
  };

  const adoptGrant = (grant) =>
    withLifecycleLock(() => adoptGrantUnlocked(grant));

  const exportLegacyRefreshToken = async (account) => {
    let stats;
    try {
      stats = fsModule.statSync(migrationTempDir);
    } catch {}
    if (!stats?.isDirectory()) {
      const error = new Error("The in-memory gog migration directory is unavailable");
      error.code = "gog_migration_tmpfs_unavailable";
      throw error;
    }
    for (const name of fsModule.readdirSync(migrationTempDir)) {
      if (/^alphaclaw-gog-export\.[0-9]+\.[a-f0-9]{16}\.json$/.test(name)) {
        fsModule.rmSync(path.join(migrationTempDir, name), { force: true });
      }
    }
    const exportPath = path.join(
      migrationTempDir,
      `alphaclaw-gog-export.${process.pid}.${crypto
        .randomBytes(8)
        .toString("hex")}.json`,
    );
    try {
      const result = await gogCmd(
        `${clientArg(account.client)}auth tokens export ${quoteShellArg(
          account.email,
        )} --out ${quoteShellArg(exportPath)} --overwrite`,
        { quiet: true, authBypass: true },
      );
      if (!result.ok) {
        const error = new Error("Failed to export the existing gog OAuth grant");
        error.code = "gog_token_export_failed";
        throw error;
      }
      const token = JSON.parse(fsModule.readFileSync(exportPath, "utf8"));
      const refreshToken = String(token.refresh_token || "").trim();
      if (!refreshToken) {
        const error = new Error("Existing gog login has no refresh token");
        error.code = "google_refresh_missing";
        throw error;
      }
      return refreshToken;
    } finally {
      fsModule.rmSync(exportPath, { force: true });
    }
  };

  const migrateLegacyAccountsUnlocked = async () => {
    if (!brokerClient.isConfigured()) return [];
    const candidates = (readState().accounts || []).filter(
      (account) => account.authenticated && !account.brokerConsumer,
    );
    const results = [];
    for (const account of candidates) {
      try {
        const credentials = readGoogleCredentials(account.client);
        if (!credentials.clientId || !credentials.clientSecret) {
          const error = new Error("Google OAuth client credentials are missing");
          error.code = "google_credentials_missing";
          throw error;
        }
        const refreshToken = await exportLegacyRefreshToken(account);
        await adoptGrantUnlocked({
          account,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          refreshToken,
          scopes: resolveOAuthScopes(account.services),
        });
        results.push({ accountId: account.id, brokered: true });
      } catch (error) {
        logger.error(
          `[alphaclaw] gog OAuth migration failed for account ${account.id} (${safeErrorCode(error)})`,
        );
        results.push({
          accountId: account.id,
          brokered: false,
          error: safeErrorCode(error),
        });
      }
    }
    return results;
  };

  const retryRevocationsUnlocked = async () => {
    fsModule.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const names = fsModule
      .readdirSync(markerDir)
      .filter((name) => /^gog-[1-5]-revocation-pending\.json$/.test(name));
    const results = [];
    for (const name of names) {
      const markerPath = path.join(markerDir, name);
      const marker = readMarker(fsModule, markerPath);
      if (!marker || !isGogBrokerConsumer(marker.consumer)) {
        results.push({ pending: true, error: "revocation_journal_invalid" });
        continue;
      }
      let localDisconnected = false;
      try {
        const state = readState();
        const current = getGoogleAccountById(state, marker.account?.id);
        let nextState = state;
        if (current) {
          ({ state: nextState } = removeGoogleAccount({
            state,
            accountId: current.id,
          }));
          saveState(nextState);
        }
        const cleanupAccount = current || marker.account;
        await removeLocalToken(cleanupAccount);
        await removeUnusedClientCredential(cleanupAccount, nextState);
        localDisconnected = true;
        await brokerClient.revokeGogGrant({ consumer: marker.consumer });
        clearMarker(fsModule, markerPath);
        results.push({
          consumer: marker.consumer,
          pending: false,
          localDisconnected,
        });
      } catch (error) {
        logger.error(
          `[alphaclaw] gog OAuth revocation retry failed (${safeErrorCode(error)})`,
        );
        results.push({
          consumer: marker.consumer,
          pending: true,
          localDisconnected,
          error: safeErrorCode(error),
        });
      }
    }
    return results;
  };

  const hasPendingRevocations = () => {
    try {
      return fsModule
        .readdirSync(markerDir)
        .some((name) => /^gog-[1-5]-revocation-pending\.json$/.test(name));
    } catch {
      return false;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
  };

  const scheduleRetry = () => {
    if (!started || retryTimer || !hasPendingRevocations()) return;
    const delays = revocationRetryDelaysMs.length
      ? revocationRetryDelaysMs
      : kRevocationRetryDelaysMs;
    const delay = Math.max(
      0,
      Number(delays[Math.min(retryAttempt, delays.length - 1)]) || 0,
    );
    retryTimer = setTimeoutFn(async () => {
      retryTimer = null;
      retryAttempt += 1;
      await withLifecycleLock(retryRevocationsUnlocked);
      if (hasPendingRevocations()) scheduleRetry();
      else clearRetryTimer();
    }, delay);
    retryTimer.unref?.();
  };

  const disconnect = ({ account }) =>
    withLifecycleLock(async () => {
      if (!isGogBrokerConsumer(account?.brokerConsumer)) {
        return { brokered: false, revocationPending: false };
      }
      const consumer = account.brokerConsumer;
      const markerPath = revocationMarkerPath(consumer);
      writeMarker(markerPath, { phase: "requested", consumer, account });
      const results = await retryRevocationsUnlocked();
      const result = results.find((entry) => entry.consumer === consumer) || {
        pending: true,
        localDisconnected: false,
        error: "revocation_journal_missing",
      };
      if (results.some((entry) => entry.pending)) scheduleRetry();
      return {
        brokered: true,
        localDisconnected: result.localDisconnected,
        revocationPending: result.pending,
        ...(result.pending ? { error: result.error } : {}),
      };
    });

  const start = () =>
    withLifecycleLock(async () => {
      if (started) return { started: true };
      started = true;
      if (!brokerClient.isConfigured()) return { started: true, configured: false };
      await retryRevocationsUnlocked();
      if (hasPendingRevocations()) scheduleRetry();
      await reconcileDepositsUnlocked();
      const migrations = await migrateLegacyAccountsUnlocked();
      return { started: true, configured: true, migrations };
    });

  const stop = () => {
    started = false;
    clearRetryTimer();
  };

  return {
    adoptGrant,
    disconnect,
    isBrokeredMode,
    start,
    stop,
  };
};

module.exports = {
  createGogBrokerService,
};
