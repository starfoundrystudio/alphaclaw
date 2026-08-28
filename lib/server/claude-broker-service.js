const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CLAUDE_BROKER_CONSUMER,
  CLAUDE_BROKER_PROVIDER,
} = require("../oauth-broker-constants");
const { ALPHACLAW_DIR } = require("./constants");

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

const createMarkerStore = ({ fsModule, markerPath, now }) => ({
  isPending: () => fsModule.existsSync(markerPath),
  read: () => {
    try {
      const value = JSON.parse(fsModule.readFileSync(markerPath, "utf8"));
      return value?.schemaVersion === 1 ? value : null;
    } catch {
      return null;
    }
  },
  write: (value) =>
    writeJsonAtomically(fsModule, markerPath, {
      schemaVersion: 1,
      updatedAt: now(),
      ...value,
    }),
  clear: () => {
    fsModule.rmSync(markerPath, { force: true });
    const directoryPath = path.dirname(markerPath);
    if (fsModule.existsSync(directoryPath)) {
      fsyncDirectory(fsModule, directoryPath);
    }
  },
});

const readClaudeCredential = ({ fsModule = fs, credentialsPath }) => {
  let parsed;
  try {
    parsed = JSON.parse(fsModule.readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    const wrapped = new Error("Claude CLI login credentials were not found");
    wrapped.code = "claude_credentials_missing";
    wrapped.cause = error;
    throw wrapped;
  }
  const oauth = parsed?.claudeAiOauth;
  const refreshToken = String(oauth?.refreshToken || "").trim();
  if (!oauth || typeof oauth !== "object" || !refreshToken) {
    const error = new Error("Claude CLI login does not contain a refresh grant");
    error.code = "claude_refresh_missing";
    throw error;
  }
  return {
    document: parsed,
    oauth,
    refreshToken,
    refreshSha256: secretHash(refreshToken),
  };
};

const sanitizeClaudeCredential = ({
  fsModule = fs,
  credentialsPath,
  expectedRefreshSha256 = "",
} = {}) => {
  if (!fsModule.existsSync(credentialsPath)) return { changed: false };
  let credential;
  try {
    credential = readClaudeCredential({ fsModule, credentialsPath });
  } catch (error) {
    if (error.code === "claude_refresh_missing") return { changed: false };
    throw error;
  }
  if (
    expectedRefreshSha256 &&
    credential.refreshSha256 !== expectedRefreshSha256
  ) {
    const error = new Error("Claude CLI login changed during broker migration");
    error.code = "claude_credential_changed";
    throw error;
  }
  const next = { ...credential.document };
  delete next.claudeAiOauth;
  writeJsonAtomically(fsModule, credentialsPath, next);
  return { changed: true };
};

const createClaudeBrokerService = ({
  brokerClient,
  authProfiles,
  fsModule = fs,
  credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json"),
  markerDir = path.join(ALPHACLAW_DIR, "oauth-broker"),
  isManagedInstance = () => false,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  revocationRetryDelaysMs = kRevocationRetryDelaysMs,
  logger = console,
} = {}) => {
  if (!brokerClient || !authProfiles) {
    throw new Error("Claude broker service dependencies are incomplete");
  }

  const depositStore = createMarkerStore({
    fsModule,
    markerPath: path.join(markerDir, "claude-deposit-pending.json"),
    now,
  });
  const revocationStore = createMarkerStore({
    fsModule,
    markerPath: path.join(markerDir, "claude-revocation-pending.json"),
    now,
  });
  let lifecycleTail = Promise.resolve();
  let started = false;
  let revocationRetryTimer = null;
  let revocationRetryAttempt = 0;
  let lastErrorCode = null;

  const withLifecycleLock = (operation) => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.catch(() => {});
    return run;
  };

  const setFailure = (error) => {
    lastErrorCode = safeErrorCode(error);
  };
  const clearFailure = () => {
    lastErrorCode = null;
  };

  const validateLease = (response) => {
    if (response.expires_at * 1000 <= now() + kMinimumAccessLifetimeMs) {
      const error = new Error("Claude broker returned an expiring access token");
      error.code = "invalid_response";
      throw error;
    }
    return response;
  };

  const hasClaudeGrant = async () => {
    const response = await brokerClient.status();
    return response.grants.some(
      (grant) =>
        grant?.consumer === CLAUDE_BROKER_CONSUMER &&
        grant?.provider === CLAUDE_BROKER_PROVIDER,
    );
  };

  const clearRevocationTimer = () => {
    if (revocationRetryTimer) clearTimeoutFn(revocationRetryTimer);
    revocationRetryTimer = null;
    revocationRetryAttempt = 0;
  };

  const scheduleRevocationRetry = () => {
    if (!started || !revocationStore.isPending() || revocationRetryTimer) return;
    const delays =
      Array.isArray(revocationRetryDelaysMs) && revocationRetryDelaysMs.length
        ? revocationRetryDelaysMs
        : kRevocationRetryDelaysMs;
    const delay = Math.max(
      0,
      Number(delays[Math.min(revocationRetryAttempt, delays.length - 1)]) || 0,
    );
    revocationRetryTimer = setTimeoutFn(async () => {
      revocationRetryTimer = null;
      revocationRetryAttempt += 1;
      const result = await retryPendingRevocation();
      if (result.pending) scheduleRevocationRetry();
    }, delay);
    revocationRetryTimer.unref?.();
  };

  const retryPendingRevocationUnlocked = async () => {
    if (!revocationStore.isPending()) {
      clearRevocationTimer();
      return { pending: false };
    }
    let localError = null;
    let brokerError = null;
    try {
      authProfiles.removeClaudeCliProfile?.();
      sanitizeClaudeCredential({ fsModule, credentialsPath });
      depositStore.clear();
    } catch (error) {
      localError = error;
    }
    try {
      await brokerClient.revokeClaudeGrant();
    } catch (error) {
      brokerError = error;
    }
    if (!localError && !brokerError) {
      revocationStore.clear();
      clearRevocationTimer();
      clearFailure();
      return { pending: false };
    }
    const error = localError || brokerError;
    setFailure(error);
    logger.error(
      `[alphaclaw] Claude OAuth broker revocation retry failed (${lastErrorCode})`,
    );
    return { pending: true, error: lastErrorCode };
  };

  const retryPendingRevocation = () =>
    withLifecycleLock(retryPendingRevocationUnlocked);

  const reconcilePendingDepositUnlocked = async () => {
    if (!depositStore.isPending()) return { pending: false };
    const marker = depositStore.read();
    if (!marker || !["prepared", "deposited"].includes(marker.phase)) {
      const error = new Error("Claude OAuth deposit journal is invalid");
      error.code = "deposit_journal_invalid";
      setFailure(error);
      return { pending: true, error: error.code };
    }

    if (marker.phase === "prepared") {
      try {
        // A lost deposit response is ambiguous. Revoke any possibly committed
        // grant and leave the local login intact so the owner can retry safely.
        await brokerClient.revokeClaudeGrant();
        depositStore.clear();
        clearFailure();
        return { pending: false, revoked: true };
      } catch (error) {
        setFailure(error);
        return { pending: true, error: lastErrorCode };
      }
    }

    try {
      let localCredential = null;
      try {
        localCredential = readClaudeCredential({ fsModule, credentialsPath });
      } catch (error) {
        if (![
          "claude_credentials_missing",
          "claude_refresh_missing",
        ].includes(error.code)) {
          throw error;
        }
      }
      if (
        localCredential &&
        localCredential.refreshSha256 !== marker.refreshSha256
      ) {
        const error = new Error("Claude CLI login changed during broker migration");
        error.code = "claude_credential_changed";
        throw error;
      }
      validateLease(await brokerClient.getClaudeAccessToken());
      if (localCredential) {
        sanitizeClaudeCredential({
          fsModule,
          credentialsPath,
          expectedRefreshSha256: marker.refreshSha256,
        });
      }
      authProfiles.upsertClaudeCliProfile?.({
        email: marker.email,
        loginMethod: marker.loginMethod,
        brokered: true,
      });
      depositStore.clear();
      clearFailure();
      return { pending: false, committed: true };
    } catch (error) {
      if (error.code === "claude_credential_changed") {
        try {
          await brokerClient.revokeClaudeGrant();
          depositStore.clear();
        } catch {}
      }
      setFailure(error);
      logger.error(
        `[alphaclaw] Claude OAuth broker deposit finalization failed (${lastErrorCode})`,
      );
      return { pending: depositStore.isPending(), error: lastErrorCode };
    }
  };

  const reconcilePendingDeposit = () =>
    withLifecycleLock(reconcilePendingDepositUnlocked);

  const adopt = ({ email = "", loginMethod = "" } = {}) =>
    withLifecycleLock(async () => {
      if (!brokerClient.isConfigured()) {
        if (isManagedInstance()) {
          const error = new Error(
            "OAuth credential broker is unavailable on this managed instance",
          );
          error.code = "not_configured";
          throw error;
        }
        authProfiles.upsertClaudeCliProfile?.({
          email,
          loginMethod,
          brokered: false,
        });
        return { brokered: false };
      }
      if (revocationStore.isPending()) {
        const revocation = await retryPendingRevocationUnlocked();
        if (revocation.pending) {
          scheduleRevocationRetry();
          const error = new Error("Previous Claude OAuth revocation is pending");
          error.code = revocation.error || "revocation_pending";
          throw error;
        }
      }
      const previousDeposit = await reconcilePendingDepositUnlocked();
      if (previousDeposit.pending) {
        const error = new Error("Previous Claude OAuth deposit is pending");
        error.code = previousDeposit.error || "deposit_pending";
        throw error;
      }

      const credential = readClaudeCredential({ fsModule, credentialsPath });
      const marker = {
        phase: "prepared",
        refreshSha256: credential.refreshSha256,
        email: String(email || "").trim(),
        loginMethod: String(loginMethod || "").trim(),
      };
      depositStore.write(marker);
      await brokerClient.depositClaudeGrant({
        refreshToken: credential.refreshToken,
      });
      depositStore.write({ ...marker, phase: "deposited" });
      validateLease(await brokerClient.getClaudeAccessToken());
      sanitizeClaudeCredential({
        fsModule,
        credentialsPath,
        expectedRefreshSha256: credential.refreshSha256,
      });
      authProfiles.upsertClaudeCliProfile?.({
        email,
        loginMethod,
        brokered: true,
      });
      depositStore.clear();
      clearFailure();
      return { brokered: true };
    });

  const disconnect = () =>
    withLifecycleLock(async () => {
      if (!brokerClient.isConfigured() && !isManagedInstance()) {
        const changed = authProfiles.removeClaudeCliProfile?.() || false;
        clearFailure();
        return {
          ok: true,
          changed,
          brokered: false,
          revocationPending: false,
        };
      }
      if (!revocationStore.isPending()) {
        revocationStore.write({ phase: "requested" });
      }
      const result = await retryPendingRevocationUnlocked();
      if (result.pending) scheduleRevocationRetry();
      return {
        ok: !result.pending,
        changed: true,
        brokered: brokerClient.isConfigured(),
        revocationPending: result.pending,
        ...(result.error ? { error: result.error } : {}),
      };
    });

  const status = async () => {
    const configured = brokerClient.isConfigured();
    let grantPresent = false;
    if (configured) {
      try {
        grantPresent = await hasClaudeGrant();
        if (grantPresent) clearFailure();
      } catch (error) {
        setFailure(error);
      }
    }
    return {
      configured,
      grantPresent,
      brokered: !!authProfiles.getClaudeCliProfile?.()?.brokered,
      depositPending: depositStore.isPending(),
      revocationPending: revocationStore.isPending(),
      error: lastErrorCode,
    };
  };

  const start = async () => {
    if (started) return status();
    started = true;
    const revocation = await retryPendingRevocation();
    if (revocation.pending) scheduleRevocationRetry();
    await reconcilePendingDeposit();
    return status();
  };

  const stop = () => {
    started = false;
    clearRevocationTimer();
  };

  return {
    adopt,
    disconnect,
    reconcilePendingDeposit,
    retryPendingRevocation,
    start,
    status,
    stop,
  };
};

module.exports = {
  createClaudeBrokerService,
  readClaudeCredential,
  sanitizeClaudeCredential,
};
