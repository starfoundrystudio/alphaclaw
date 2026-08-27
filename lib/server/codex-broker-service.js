const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const {
  CODEX_BROKER_CONSUMER,
  CODEX_BROKER_PROVIDER,
  CODEX_BROKER_REFRESH_PLACEHOLDER,
  isBrokeredCodexCredential,
} = require("../oauth-broker-constants");
const { ALPHACLAW_DIR } = require("./constants");

// OpenClaw 2026.7.1 starts its own OAuth refresh at five minutes. Refresh
// earlier so it never races the non-secret placeholder in the auth store.
const kRefreshMarginMs = 10 * 60 * 1000;
const kRefreshRetryMs = 60 * 1000;
const kHealthCheckIntervalMs = 5 * 60 * 1000;
const kMaxTimerDelayMs = 2 ** 31 - 1;
const kReconnectErrorCodes = new Set([
  "grant_not_found",
  "provider_http_400",
  "provider_http_401",
  "provider_http_403",
]);

const safeErrorCode = (error) => {
  const code = String(error?.code || "broker_unavailable");
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "broker_unavailable";
};

const createOpenclawCredentialPublisher = ({
  isGatewayRunning,
  hasActiveManagedGatewayChild,
  clawCmd,
}) => async () => {
  if (!(await isGatewayRunning())) {
    if (hasActiveManagedGatewayChild()) {
      const error = new Error(
        "OpenClaw is still starting with an older credential snapshot",
      );
      error.code = "runtime_starting";
      throw error;
    }
    return { published: false };
  }
  const result = await clawCmd("secrets reload --json", {
    quiet: true,
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    const error = new Error("OpenClaw rejected the refreshed credential snapshot");
    error.code = "runtime_reload_failed";
    throw error;
  }
  return { published: true };
};

const createFileMarkerStore = ({ markerPath, now, kind }) => ({
  isPending: () => fs.existsSync(markerPath),
  read: () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      return parsed?.schemaVersion === 1 && parsed?.kind === kind ? parsed : null;
    } catch {
      return null;
    }
  },
  mark: (details = {}) => {
    const markerDir = path.dirname(markerPath);
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${markerPath}.tmp.${process.pid}.${crypto
      .randomBytes(8)
      .toString("hex")}`;
    try {
      const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          descriptor,
          `${JSON.stringify({ schemaVersion: 1, kind, requestedAt: now(), ...details })}\n`,
        );
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, markerPath);
      const directoryDescriptor = fs.openSync(markerDir, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  },
  clear: () => {
    const markerDir = path.dirname(markerPath);
    fs.rmSync(markerPath, { force: true });
    if (!fs.existsSync(markerDir)) return;
    const directoryDescriptor = fs.openSync(markerDir, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  },
});

const accessTokenHash = (accessToken) =>
  crypto.createHash("sha256").update(String(accessToken || ""), "utf8").digest("hex");

const createCodexBrokerService = ({
  brokerClient,
  authProfiles,
  clientId,
  scopes,
  getCodexAccountId,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  refreshMarginMs = kRefreshMarginMs,
  refreshRetryMs = kRefreshRetryMs,
  healthCheckIntervalMs = kHealthCheckIntervalMs,
  pendingRevocationStore,
  pendingDepositStore,
  pendingPublicationStore,
  pendingAccessPublicationStore,
  isManagedInstance = () => false,
  publishCredentials = async () => {},
} = {}) => {
  if (!brokerClient || !authProfiles || !clientId || !Array.isArray(scopes)) {
    throw new Error("Codex broker service dependencies are incomplete");
  }

  let started = false;
  let refreshTimer = null;
  let healthTimer = null;
  let refreshPromise = null;
  let healthPromise = null;
  let lastRefreshAt = null;
  let lastHealthAt = null;
  let lastErrorAt = null;
  let lastErrorCode = null;
  let channelHealthy = null;
  let lifecycleTail = Promise.resolve();
  const revocationStore =
    pendingRevocationStore ||
    createFileMarkerStore({
      markerPath: path.join(
        ALPHACLAW_DIR,
        "oauth-broker",
        "codex-revocation-pending.json",
      ),
      now,
      kind: "revoke",
    });
  const depositStore =
    pendingDepositStore ||
    createFileMarkerStore({
      markerPath: path.join(
        ALPHACLAW_DIR,
        "oauth-broker",
        "codex-deposit-pending.json",
      ),
      now,
      kind: "deposit",
    });
  const publicationStore =
    pendingPublicationStore ||
    createFileMarkerStore({
      markerPath: path.join(
        ALPHACLAW_DIR,
        "oauth-broker",
        "codex-publication-pending.json",
      ),
      now,
      kind: "publication",
    });
  const accessPublicationStore =
    pendingAccessPublicationStore ||
    createFileMarkerStore({
      markerPath: path.join(
        ALPHACLAW_DIR,
        "oauth-broker",
        "codex-access-publication-pending.json",
      ),
      now,
      kind: "access-publication",
    });

  const withLifecycleLock = (operation) => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.catch(() => {});
    return run;
  };

  const brokerConfigured = () => brokerClient.isConfigured();
  const getProfile = () => authProfiles.getCodexProfile();
  const isBrokeredProfile = (profile = getProfile()) =>
    isBrokeredCodexCredential(profile);

  const clearRefreshTimer = () => {
    if (refreshTimer) clearTimeoutFn(refreshTimer);
    refreshTimer = null;
  };

  const setFailure = (error) => {
    lastErrorAt = now();
    lastErrorCode = safeErrorCode(error);
  };

  const clearFailure = () => {
    lastErrorAt = null;
    lastErrorCode = null;
  };

  const scheduleRefresh = (delayMs) => {
    clearRefreshTimer();
    if (!started || !isBrokeredProfile()) return;
    const delay = Math.min(kMaxTimerDelayMs, Math.max(0, Math.floor(delayMs)));
    refreshTimer = setTimeoutFn(() => {
      refreshTimer = null;
      refreshNow().catch(() => {});
    }, delay);
    refreshTimer.unref?.();
  };

  const scheduleForProfile = (profile = getProfile()) => {
    if (!isBrokeredProfile(profile)) {
      clearRefreshTimer();
      return;
    }
    if (lastErrorCode) {
      scheduleRefresh(refreshRetryMs);
      return;
    }
    const expires = Number(profile.expires || 0);
    scheduleRefresh(Math.max(0, expires - now() - refreshMarginMs));
  };

  const persistAccessToken = async ({ accessToken, expiresAtMs }) => {
    const accountId = getCodexAccountId(accessToken);
    // Persist intent before the SQLite mutation. If the process dies or the
    // gateway is still starting, gateway-ready recovery republishes the
    // current brokered profile instead of waiting for another token refresh.
    accessPublicationStore.mark();
    authProfiles.upsertCodexProfile({
      access: accessToken,
      refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
      expires: expiresAtMs,
      accountId,
    });
    await publishCredentials();
    accessPublicationStore.clear();
  };

  async function refreshNow() {
    if (refreshPromise) return refreshPromise;
    const profile = getProfile();
    if (!isBrokeredProfile(profile)) return { refreshed: false, reason: "not_brokered" };

    refreshPromise = withLifecycleLock(async () => {
      try {
        const depositRecovery = await reconcilePendingDepositUnlocked();
        if (depositRecovery.pending) {
          const error = new Error("OAuth deposit finalization is still pending");
          error.code = depositRecovery.error || "deposit_pending";
          throw error;
        }
        const currentProfile = getProfile();
        if (!isBrokeredProfile(currentProfile) || revocationStore.isPending()) {
          return { refreshed: false, reason: "not_brokered" };
        }
        if (!brokerConfigured()) {
          const error = new Error("OAuth credential broker is not configured");
          error.code = "not_configured";
          throw error;
        }
        const response = await brokerClient.getCodexAccessToken({ scopes });
        const expiresAtMs = response.expires_at * 1000;
        if (expiresAtMs <= now() + 60 * 1000) {
          const error = new Error("OAuth credential broker returned an expiring token");
          error.code = "invalid_response";
          throw error;
        }
        if (
          response.refreshed !== true &&
          expiresAtMs <= now() + refreshMarginMs
        ) {
          const error = new Error(
            "OAuth credential broker deferred a required early refresh",
          );
          error.code = "refresh_deferred";
          throw error;
        }
        await persistAccessToken({
          accessToken: response.access_token,
          expiresAtMs,
        });
        lastRefreshAt = now();
        channelHealthy = true;
        clearFailure();
        return {
          refreshed: response.refreshed === true,
          expires: expiresAtMs,
        };
      } catch (error) {
        channelHealthy = false;
        setFailure(error);
        logger.error(
          `[alphaclaw] Codex OAuth broker refresh failed (${lastErrorCode})`,
        );
        throw error;
      } finally {
        refreshPromise = null;
        scheduleForProfile();
      }
    });
    return refreshPromise;
  }

  const checkHealth = async () => {
    if (healthPromise) return healthPromise;
    if (!brokerConfigured() || !isBrokeredProfile()) {
      channelHealthy = null;
      return { checked: false };
    }
    healthPromise = (async () => {
      try {
        const response = await brokerClient.status();
        const hasGrant = response.grants.some(
          (grant) =>
            grant?.consumer === CODEX_BROKER_CONSUMER &&
            grant?.provider === CODEX_BROKER_PROVIDER,
        );
        if (response.denied || response.kek_present !== true || !hasGrant) {
          const error = new Error("OAuth credential broker is unavailable");
          error.code = !hasGrant
            ? "grant_not_found"
            : response.denied
              ? "broker_denied"
              : "kek_missing";
          throw error;
        }
        channelHealthy = true;
        lastHealthAt = now();
        return { checked: true, healthy: true };
      } catch (error) {
        channelHealthy = false;
        lastHealthAt = now();
        setFailure(error);
        scheduleForProfile();
        logger.error(
          `[alphaclaw] Codex OAuth broker health check failed (${lastErrorCode})`,
        );
        return { checked: true, healthy: false, error: lastErrorCode };
      } finally {
        healthPromise = null;
      }
    })();
    return healthPromise;
  };

  const retryPendingRevocationUnlocked = async () => {
    if (!revocationStore.isPending()) return { pending: false };
    // A durable marker records the user's disconnect intent. If the process
    // crashed before the local delete, finish that fail-closed transition
    // before retrying the gateway operation.
    let changed = false;
    let localError = null;
    try {
      changed = authProfiles.removeCodexProfiles();
    } catch (error) {
      localError = error;
    }
    let publishError = null;
    let revokeError = null;
    let revoke = null;
    // The SQLite deletion may have committed before later cleanup threw.
    // Always publish the current store so the live runtime loses the token,
    // while retaining the journal for whichever cleanup step still failed.
    try {
      await publishCredentials();
    } catch (error) {
      publishError = error;
    }
    try {
      revoke = await brokerClient.revokeCodexGrant();
    } catch (error) {
      revokeError = error;
    }
    if (!localError && !publishError && !revokeError) {
      try {
        depositStore.clear();
        accessPublicationStore.clear();
        revocationStore.clear();
        channelHealthy = true;
        clearFailure();
        return {
          pending: false,
          changed,
          providerRevocation: revoke.provider_revocation,
        };
      } catch (error) {
        publishError = error;
      }
    }
    const error = localError || publishError || revokeError;
    channelHealthy = false;
    setFailure(error);
    logger.error(
      `[alphaclaw] Codex OAuth broker revocation retry failed (${lastErrorCode})`,
    );
    return { pending: true, changed, error: lastErrorCode };
  };

  const retryPendingRevocation = () =>
    withLifecycleLock(retryPendingRevocationUnlocked);

  const reconcilePendingDepositUnlocked = async () => {
    if (!depositStore.isPending()) return { pending: false };
    const profile = getProfile();
    const journal = depositStore.read?.() || null;
    const journalMatchesProfile =
      isBrokeredProfile(profile) &&
      typeof journal?.accessSha256 === "string" &&
      journal.accessSha256 === accessTokenHash(profile.access);
    if (journalMatchesProfile) {
      try {
        // SQLite writes are atomic. A local broker marker means the deposit
        // committed before the process died. Re-run ancillary cleanup and
        // live-snapshot publication before completing the journal.
        authProfiles.upsertCodexProfile({
          access: profile.access,
          refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
          expires: profile.expires,
          accountId: profile.accountId,
        });
        await publishCredentials();
        depositStore.clear();
        return { pending: false, committed: true };
      } catch (error) {
        channelHealthy = false;
        setFailure(error);
        logger.error(
          `[alphaclaw] Codex OAuth broker deposit finalization failed (${lastErrorCode})`,
        );
        return { pending: true, error: lastErrorCode };
      }
    }
    try {
      await brokerClient.revokeCodexGrant();
      depositStore.clear();
      return { pending: false, revoked: true };
    } catch (error) {
      channelHealthy = false;
      setFailure(error);
      logger.error(
        `[alphaclaw] Codex OAuth broker deposit recovery failed (${lastErrorCode})`,
      );
      return { pending: true, error: lastErrorCode };
    }
  };

  const reconcilePendingDeposit = () =>
    withLifecycleLock(reconcilePendingDepositUnlocked);

  const retryPendingPublicationUnlocked = async () => {
    if (!publicationStore.isPending()) return { pending: false, changed: false };
    let changed = false;
    let localError = null;
    let publishError = null;
    try {
      changed = authProfiles.removeCodexProfiles();
    } catch (error) {
      localError = error;
    }
    try {
      await publishCredentials();
    } catch (error) {
      publishError = error;
    }
    try {
      if (localError || publishError) throw localError || publishError;
      accessPublicationStore.clear();
      publicationStore.clear();
      clearFailure();
      return { pending: false, changed };
    } catch (error) {
      setFailure(error);
      logger.error(
        `[alphaclaw] Codex runtime credential removal retry failed (${lastErrorCode})`,
      );
      return { pending: true, changed, error: lastErrorCode };
    }
  };

  const retryPendingPublication = () =>
    withLifecycleLock(retryPendingPublicationUnlocked);

  const retryPendingAccessPublicationUnlocked = async () => {
    if (!accessPublicationStore.isPending()) {
      return { pending: false, published: false };
    }
    if (!isBrokeredProfile()) {
      accessPublicationStore.clear();
      return { pending: false, published: false };
    }
    try {
      await publishCredentials();
      accessPublicationStore.clear();
      clearFailure();
      return { pending: false, published: true };
    } catch (error) {
      setFailure(error);
      logger.error(
        `[alphaclaw] Codex access publication retry failed (${lastErrorCode})`,
      );
      return { pending: true, published: false, error: lastErrorCode };
    }
  };

  const retryPendingAccessPublication = () =>
    withLifecycleLock(retryPendingAccessPublicationUnlocked);

  const retryPendingLifecycle = () =>
    withLifecycleLock(async () => {
      const revocation = await retryPendingRevocationUnlocked();
      const deposit = await reconcilePendingDepositUnlocked();
      const accessPublication = await retryPendingAccessPublicationUnlocked();
      const publication = await retryPendingPublicationUnlocked();
      return { revocation, deposit, accessPublication, publication };
    });

  const storeTokens = ({ access, refresh, expires, accountId }) =>
    withLifecycleLock(async () => {
      // A failed legacy disconnect may have removed the durable profile but
      // not the running OpenClaw snapshot. Finish that fail-closed removal
      // before accepting any replacement credential, brokered or otherwise.
      const previousPublication = await retryPendingPublicationUnlocked();
      if (previousPublication.pending) {
        const error = new Error("Previous runtime credential removal is pending");
        error.code = previousPublication.error || "publication_pending";
        throw error;
      }
      const previousAccessPublication =
        await retryPendingAccessPublicationUnlocked();
      if (previousAccessPublication.pending) {
        const error = new Error("Previous access-token publication is pending");
        error.code = previousAccessPublication.error || "publication_pending";
        throw error;
      }
      if (!brokerConfigured()) {
        if (isManagedInstance()) {
          const error = new Error(
            "OAuth credential broker is unavailable on this managed instance",
          );
          error.code = "not_configured";
          throw error;
        }
        authProfiles.upsertCodexProfile({ access, refresh, expires, accountId });
        return { brokered: false };
      }

      // A reconnect cannot overtake a previously requested disconnect. Finish
      // the old revoke first, under the same lifecycle serialization point.
      if (revocationStore.isPending()) {
        const previousRevoke = await retryPendingRevocationUnlocked();
        if (previousRevoke.pending) {
          const error = new Error("Previous OAuth revocation is still pending");
          error.code = previousRevoke.error || "revocation_pending";
          throw error;
        }
      }
      const previousDeposit = await reconcilePendingDepositUnlocked();
      if (previousDeposit.pending) {
        const error = new Error("Previous OAuth deposit is still pending");
        error.code = previousDeposit.error || "deposit_pending";
        throw error;
      }
      depositStore.mark({ accessSha256: accessTokenHash(access) });
      let deposited = false;
      let committed = false;
      try {
        await brokerClient.depositCodexGrant({
          clientId,
          refreshToken: refresh,
          scopes,
        });
        deposited = true;
        authProfiles.upsertCodexProfile({
          access,
          refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
          expires,
          accountId,
        });
        committed = true;
      } catch (error) {
        committed = committed || isBrokeredProfile();
        if (deposited && !committed) {
          try {
            await brokerClient.revokeCodexGrant();
            depositStore.clear();
          } catch {}
        }
        // A failed or lost deposit response is ambiguous: the gateway may
        // already have committed the grant. Keep the journal so recovery can
        // issue an idempotent revoke rather than orphaning a durable secret.
        throw error;
      }

      try {
        await publishCredentials();
        depositStore.clear();
      } catch (error) {
        channelHealthy = false;
        setFailure(error);
        scheduleForProfile();
        throw error;
      }
      channelHealthy = true;
      lastHealthAt = now();
      clearFailure();
      scheduleForProfile();
      return { brokered: true };
    });

  const disconnect = () => withLifecycleLock(async () => {
    const profile = getProfile();
    const brokered = isBrokeredProfile(profile);
    const requiresBrokerRevoke =
      brokered ||
      brokerConfigured() ||
      revocationStore.isPending() ||
      depositStore.isPending();
    if (requiresBrokerRevoke) {
      try {
        if (!revocationStore.isPending()) revocationStore.mark();
      } catch {
        setFailure({ code: "revocation_marker_unavailable" });
        logger.error(
          "[alphaclaw] Could not persist the Codex OAuth revocation retry marker",
        );
        return {
          ok: false,
          changed: false,
          brokered: requiresBrokerRevoke,
          error: lastErrorCode,
          revocationPending: false,
        };
      }
    }
    if (!requiresBrokerRevoke) {
      try {
        if (!publicationStore.isPending()) publicationStore.mark();
      } catch {
        setFailure({ code: "publication_marker_unavailable" });
        return {
          ok: false,
          changed: false,
          brokered: false,
          error: lastErrorCode,
          publicationPending: false,
        };
      }
      const closeout = await retryPendingPublicationUnlocked();
      return closeout.pending
        ? {
            ok: false,
            changed: closeout.changed,
            brokered: false,
            error: closeout.error,
            publicationPending: true,
          }
        : { ok: true, changed: closeout.changed, brokered: false };
    }
    const closeout = await retryPendingRevocationUnlocked();
    const changed = closeout.changed === true;
    clearRefreshTimer();
    if (!closeout.pending) {
      return {
        ok: true,
        changed,
        brokered: requiresBrokerRevoke,
        providerRevocation: closeout.providerRevocation,
      };
    }
    return {
      ok: false,
      changed,
      brokered: requiresBrokerRevoke,
      error: closeout.error,
      revocationPending: revocationStore.isPending(),
    };
  });

  const getStatus = () => {
    const profile = getProfile();
    const configured = brokerConfigured();
    const brokered = isBrokeredProfile(profile);
    const expired = brokered && Number(profile.expires || 0) <= now();
    let state = "idle";
    if (profile && !brokered) state = configured ? "local_legacy" : "local";
    if (brokered) {
      if (!configured) state = "unavailable";
      else if (refreshPromise) state = "refreshing";
      else if (expired) state = "expired";
      else if (lastErrorCode || channelHealthy === false) state = "degraded";
      else state = "healthy";
    }
    return {
      configured,
      brokered,
      state,
      healthy: brokered ? state === "healthy" || state === "refreshing" : null,
      expires: brokered && typeof profile.expires === "number" ? profile.expires : null,
      lastRefreshAt,
      lastHealthAt,
      lastErrorAt,
      lastErrorCode,
      reconnectRequired: brokered && kReconnectErrorCodes.has(lastErrorCode),
      revocationPending: revocationStore.isPending(),
      depositPending: depositStore.isPending(),
      publicationPending: publicationStore.isPending(),
      accessPublicationPending: accessPublicationStore.isPending(),
    };
  };

  const start = async () => {
    if (started) return getStatus();
    started = true;
    if (healthCheckIntervalMs > 0) {
      healthTimer = setIntervalFn(async () => {
        try {
          await retryPendingRevocation();
          await reconcilePendingDeposit();
          await retryPendingAccessPublication();
          await retryPendingPublication();
          await checkHealth();
        } catch (error) {
          setFailure(error);
          logger.error(
            `[alphaclaw] Codex OAuth broker maintenance failed (${lastErrorCode})`,
          );
        }
      }, healthCheckIntervalMs);
      healthTimer.unref?.();
    }
    await retryPendingRevocation();
    await reconcilePendingDeposit();
    await retryPendingAccessPublication();
    await retryPendingPublication();
    if (isBrokeredProfile()) {
      try {
        await refreshNow();
      } catch {}
    }
    return getStatus();
  };

  const stop = () => {
    started = false;
    clearRefreshTimer();
    if (healthTimer) clearIntervalFn(healthTimer);
    healthTimer = null;
  };

  return {
    checkHealth,
    disconnect,
    getStatus,
    isBrokeredProfile,
    refreshNow,
    reconcilePendingDeposit,
    retryPendingPublication,
    retryPendingAccessPublication,
    retryPendingLifecycle,
    retryPendingRevocation,
    start,
    stop,
    storeTokens,
  };
};

module.exports = {
  createOpenclawCredentialPublisher,
  createFileMarkerStore,
  createCodexBrokerService,
  kHealthCheckIntervalMs,
  kRefreshMarginMs,
  kRefreshRetryMs,
};
