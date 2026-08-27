const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  CODEX_BROKER_REFRESH_PLACEHOLDER,
} = require("../../lib/oauth-broker-constants");
const {
  createOpenclawCredentialPublisher,
  createFileMarkerStore,
  createCodexBrokerService,
} = require("../../lib/server/codex-broker-service");

const createHarness = ({
  configured = true,
  managed = false,
  profile = null,
  depositPending: initialDepositPending = false,
  now = 1_700_000_000_000,
  publishCredentials = vi.fn().mockResolvedValue(undefined),
} = {}) => {
  let currentProfile = profile;
  let revocationPending = false;
  let publicationPending = false;
  let accessPublicationPending = false;
  let depositJournal = initialDepositPending
    ? {
        accessSha256: crypto
          .createHash("sha256")
          .update(String(profile?.access || ""), "utf8")
          .digest("hex"),
      }
    : null;
  const timers = [];
  const brokerClient = {
    isConfigured: vi.fn(() => configured),
    depositCodexGrant: vi.fn().mockResolvedValue(true),
    getCodexAccessToken: vi.fn().mockResolvedValue({
      access_token: "broker-access",
      expires_at: Math.floor(now / 1000) + 3600,
      scopes: ["openid", "offline_access"],
      scopes_known: true,
      refreshed: true,
    }),
    status: vi.fn().mockResolvedValue({
      denied: false,
      kek_present: true,
      grants: [{ consumer: "openclaw-codex", provider: "openai" }],
    }),
    revokeCodexGrant: vi.fn().mockResolvedValue({
      revoked: true,
      provider_revocation: "succeeded",
    }),
  };
  const authProfiles = {
    getCodexProfile: vi.fn(() => currentProfile),
    upsertCodexProfile: vi.fn((credential) => {
      currentProfile = {
        profileId: "openai:codex-cli",
        type: "oauth",
        provider: "openai",
        ...credential,
      };
    }),
    removeCodexProfiles: vi.fn(() => {
      const changed = currentProfile !== null;
      currentProfile = null;
      return changed;
    }),
  };
  const service = createCodexBrokerService({
    brokerClient,
    authProfiles,
    clientId: "client-id",
    scopes: ["openid", "offline_access"],
    getCodexAccountId: vi.fn(() => "account-from-access"),
    now: () => now,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref: vi.fn() };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: vi.fn(),
    setIntervalFn: () => ({ unref: vi.fn() }),
    clearIntervalFn: vi.fn(),
    logger: { error: vi.fn() },
    isManagedInstance: () => managed,
    publishCredentials,
    pendingRevocationStore: {
      isPending: vi.fn(() => revocationPending),
      mark: vi.fn(() => {
        revocationPending = true;
      }),
      clear: vi.fn(() => {
        revocationPending = false;
      }),
    },
    pendingDepositStore: {
      isPending: vi.fn(() => depositJournal !== null),
      read: vi.fn(() => depositJournal),
      mark: vi.fn((details) => {
        depositJournal = details;
      }),
      clear: vi.fn(() => {
        depositJournal = null;
      }),
    },
    pendingPublicationStore: {
      isPending: vi.fn(() => publicationPending),
      mark: vi.fn(() => {
        publicationPending = true;
      }),
      clear: vi.fn(() => {
        publicationPending = false;
      }),
    },
    pendingAccessPublicationStore: {
      isPending: vi.fn(() => accessPublicationPending),
      mark: vi.fn(() => {
        accessPublicationPending = true;
      }),
      clear: vi.fn(() => {
        accessPublicationPending = false;
      }),
    },
  });
  return {
    service,
    brokerClient,
    authProfiles,
    timers,
    publishCredentials,
    getProfile: () => currentProfile,
    getDepositPending: () => depositJournal !== null,
    getPublicationPending: () => publicationPending,
    getAccessPublicationPending: () => accessPublicationPending,
    advanceNow: (milliseconds) => {
      now += milliseconds;
    },
  };
};

describe("server/codex-broker-service", () => {
  it("keeps publication pending while a gateway child is still starting", async () => {
    const clawCmd = vi.fn();
    const publish = createOpenclawCredentialPublisher({
      isGatewayRunning: vi.fn().mockResolvedValue(false),
      hasActiveManagedGatewayChild: vi.fn(() => true),
      clawCmd,
    });

    await expect(publish()).rejects.toMatchObject({ code: "runtime_starting" });
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("reloads credentials once the gateway is listening", async () => {
    const clawCmd = vi.fn().mockResolvedValue({ ok: true });
    const publish = createOpenclawCredentialPublisher({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      hasActiveManagedGatewayChild: vi.fn(() => true),
      clawCmd,
    });

    await expect(publish()).resolves.toEqual({ published: true });
    expect(clawCmd).toHaveBeenCalledWith("secrets reload --json", {
      quiet: true,
      timeoutMs: 15_000,
    });
  });

  it("publishes transaction markers with an atomic rename", () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-oauth-marker-"));
    const markerPath = path.join(markerDir, "deposit.json");
    const store = createFileMarkerStore({
      markerPath,
      now: () => 1_700_000_000_000,
      kind: "deposit",
    });
    const rename = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw new Error("simulated crash before rename");
      });
    try {
      expect(() => store.mark({ accessSha256: "digest" })).toThrow(
        "simulated crash before rename",
      );
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.readdirSync(markerDir)).toEqual([]);
      rename.mockRestore();

      store.mark({ accessSha256: "digest" });
      expect(store.read()).toMatchObject({
        schemaVersion: 1,
        kind: "deposit",
        accessSha256: "digest",
      });
      expect(fs.readdirSync(markerDir)).toEqual(["deposit.json"]);
    } finally {
      rename.mockRestore();
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it("deposits before persisting and never writes the refresh token locally", async () => {
    const harness = createHarness();

    await harness.service.storeTokens({
      access: "initial-access",
      refresh: "durable-refresh",
      expires: 1_700_003_600_000,
      accountId: "account",
    });

    expect(harness.brokerClient.depositCodexGrant).toHaveBeenCalledWith({
      clientId: "client-id",
      refreshToken: "durable-refresh",
      scopes: ["openid", "offline_access"],
    });
    expect(harness.authProfiles.upsertCodexProfile).toHaveBeenCalledWith({
      access: "initial-access",
      refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
      expires: 1_700_003_600_000,
      accountId: "account",
    });
    expect(JSON.stringify(harness.getProfile())).not.toContain("durable-refresh");
  });

  it("immediately brokers an initial token already inside the safe refresh window", async () => {
    const harness = createHarness();

    await harness.service.start();
    await harness.service.storeTokens({
      access: "initial-access",
      refresh: "durable-refresh",
      expires: 1_700_000_420_000,
    });

    expect(harness.timers.at(-1).delay).toBe(0);
  });

  it("fails closed when deposit fails", async () => {
    const harness = createHarness();
    harness.brokerClient.depositCodexGrant.mockRejectedValue(
      Object.assign(new Error("unavailable"), { code: "ssh_failed" }),
    );

    await expect(
      harness.service.storeTokens({
        access: "initial-access",
        refresh: "durable-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toThrow("unavailable");
    expect(harness.authProfiles.upsertCodexProfile).not.toHaveBeenCalled();
    expect(harness.getDepositPending()).toBe(true);
  });

  it("does not revoke a deposit after the broker marker committed locally", async () => {
    const harness = createHarness();
    const persist = harness.authProfiles.upsertCodexProfile.getMockImplementation();
    harness.authProfiles.upsertCodexProfile.mockImplementationOnce((credential) => {
      persist(credential);
      throw new Error("legacy cleanup failed after commit");
    });

    await expect(
      harness.service.storeTokens({
        access: "access",
        refresh: "durable-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toThrow("legacy cleanup failed after commit");

    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
    expect(harness.getDepositPending()).toBe(true);
    await harness.service.reconcilePendingDeposit();
    expect(harness.getDepositPending()).toBe(false);
  });

  it("does not mistake an older brokered profile for the current deposit", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    harness.authProfiles.upsertCodexProfile.mockImplementationOnce(() => {
      throw new Error("SQLite unavailable before commit");
    });

    await expect(
      harness.service.storeTokens({
        access: "new-access",
        refresh: "new-refresh",
        expires: 1_700_007_200_000,
      }),
    ).rejects.toThrow("SQLite unavailable before commit");
    expect(harness.getDepositPending()).toBe(true);

    await harness.service.reconcilePendingDeposit();

    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.getDepositPending()).toBe(false);
    expect(harness.getProfile()?.access).toBe("old-access");
  });

  it("clears a pending disconnect when the user explicitly reconnects", async () => {
    let pending = true;
    let depositPending = false;
    const harness = createHarness();
    const service = createCodexBrokerService({
      brokerClient: harness.brokerClient,
      authProfiles: harness.authProfiles,
      clientId: "client-id",
      scopes: ["openid"],
      getCodexAccountId: vi.fn(),
      logger: { error: vi.fn() },
      pendingRevocationStore: {
        isPending: () => pending,
        mark: () => {
          pending = true;
        },
        clear: () => {
          pending = false;
        },
      },
      pendingDepositStore: {
        isPending: () => depositPending,
        mark: () => {
          depositPending = true;
        },
        clear: () => {
          depositPending = false;
        },
      },
    });

    await service.storeTokens({
      access: "access",
      refresh: "new-refresh",
      expires: 1_700_003_600_000,
    });

    expect(pending).toBe(false);
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.brokerClient.revokeCodexGrant.mock.invocationCallOrder[0]).toBeLessThan(
      harness.brokerClient.depositCodexGrant.mock.invocationCallOrder[0],
    );
    expect(harness.getProfile()?.refresh).toBe(CODEX_BROKER_REFRESH_PLACEHOLDER);
  });

  it("does not deposit a new grant while prior disconnect intent remains", async () => {
    const harness = createHarness();
    const service = createCodexBrokerService({
      brokerClient: harness.brokerClient,
      authProfiles: harness.authProfiles,
      clientId: "client-id",
      scopes: ["openid"],
      getCodexAccountId: vi.fn(),
      logger: { error: vi.fn() },
      pendingRevocationStore: {
        isPending: () => true,
        mark: vi.fn(),
        clear: () => {
          throw new Error("read-only filesystem");
        },
      },
      pendingDepositStore: {
        isPending: () => false,
        mark: vi.fn(),
        clear: vi.fn(),
      },
    });

    await expect(
      service.storeTokens({
        access: "access",
        refresh: "new-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toThrow("Previous OAuth revocation is still pending");

    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.brokerClient.depositCodexGrant).not.toHaveBeenCalled();
    expect(harness.getProfile()).toBeNull();
  });

  it("keeps unmanaged installs on their existing local credential path", async () => {
    const harness = createHarness({ configured: false });

    const result = await harness.service.storeTokens({
      access: "access",
      refresh: "refresh",
      expires: 1_700_003_600_000,
    });

    expect(result).toEqual({ brokered: false });
    expect(harness.brokerClient.depositCodexGrant).not.toHaveBeenCalled();
    expect(harness.authProfiles.upsertCodexProfile).toHaveBeenCalledWith({
      access: "access",
      refresh: "refresh",
      expires: 1_700_003_600_000,
    });
  });

  it("refuses to persist a refresh token when a managed broker identity is incomplete", async () => {
    const harness = createHarness({ configured: false, managed: true });

    await expect(
      harness.service.storeTokens({
        access: "access",
        refresh: "durable-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });

    expect(harness.authProfiles.upsertCodexProfile).not.toHaveBeenCalled();
  });

  it("refreshes on boot and schedules before OpenClaw's five-minute refresh window", async () => {
    const harness = createHarness({
      profile: {
        profileId: "openai:codex-cli",
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_001_000_000,
      },
    });

    await harness.service.start();

    expect(harness.brokerClient.getCodexAccessToken).toHaveBeenCalledTimes(1);
    expect(harness.getProfile()).toMatchObject({
      access: "broker-access",
      refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
      expires: 1_700_003_600_000,
      accountId: "account-from-access",
    });
    expect(harness.timers.at(-1).delay).toBe(50 * 60 * 1000);
    expect(harness.service.getStatus()).toMatchObject({
      brokered: true,
      state: "healthy",
      healthy: true,
    });
  });

  it("backs off instead of looping when an old broker defers early refresh", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_600_000,
      },
    });
    harness.brokerClient.getCodexAccessToken.mockResolvedValue({
      access_token: "same-access",
      expires_at: 1_700_000_600,
      scopes: [],
      scopes_known: true,
      refreshed: false,
    });

    await harness.service.start();

    expect(harness.authProfiles.upsertCodexProfile).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      state: "degraded",
      lastErrorCode: "refresh_deferred",
    });
    expect(harness.timers.at(-1).delay).toBe(60 * 1000);
  });

  it("schedules short-lived refreshed tokens before OpenClaw's expiry window", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });
    harness.brokerClient.getCodexAccessToken.mockResolvedValue({
      access_token: "short-lived-access",
      expires_at: 1_700_000_600,
      scopes: [],
      scopes_known: true,
      refreshed: true,
    });

    await harness.service.start();

    expect(harness.getProfile()?.expires).toBe(1_700_000_600_000);
    expect(harness.timers.at(-1).delay).toBe(2 * 60 * 1000);
  });

  it("keeps a retry and operation budget before OpenClaw's expiry window", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.service.storeTokens({
      access: "initial-access",
      refresh: "durable-refresh",
      expires: 1_700_000_600_000,
    });
    expect(harness.timers.at(-1).delay).toBe(2 * 60 * 1000);

    harness.brokerClient.getCodexAccessToken.mockRejectedValue(
      Object.assign(new Error("temporary outage"), { code: "ssh_failed" }),
    );
    harness.advanceNow(2 * 60 * 1000);
    harness.timers.at(-1).callback();
    await vi.waitFor(() => {
      expect(harness.service.getStatus().lastErrorCode).toBe("ssh_failed");
    });

    expect(harness.timers.at(-1).delay).toBe(60 * 1000);
    // The retry starts with seven minutes remaining: one operation minute and
    // one safety minute still fit before OpenClaw's five-minute boundary.
    expect(harness.getProfile().expires - 1_700_000_120_000).toBe(8 * 60 * 1000);
  });

  it("rejects tokens too short-lived to refresh before OpenClaw's expiry window", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });
    harness.brokerClient.getCodexAccessToken.mockResolvedValue({
      access_token: "too-short-lived",
      expires_at: 1_700_000_420,
      scopes: [],
      scopes_known: true,
      refreshed: true,
    });

    await harness.service.start();

    expect(harness.authProfiles.upsertCodexProfile).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      state: "degraded",
      lastErrorCode: "invalid_response",
    });
    expect(harness.timers.at(-1).delay).toBe(60 * 1000);
  });

  it("coalesces concurrent refreshes into one broker request", async () => {
    let release;
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });
    harness.brokerClient.getCodexAccessToken.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    const first = harness.service.refreshNow();
    const second = harness.service.refreshNow();
    await vi.waitFor(() => {
      expect(harness.brokerClient.getCodexAccessToken).toHaveBeenCalledTimes(1);
    });
    release({
      access_token: "new",
      expires_at: 1_700_003_600,
      scopes: [],
      scopes_known: true,
      refreshed: true,
    });
    await Promise.all([first, second]);
    expect(harness.authProfiles.upsertCodexProfile).toHaveBeenCalledTimes(1);
  });

  it("publishes a refreshed store into OpenClaw's live runtime snapshot", async () => {
    const publishCredentials = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({
      publishCredentials,
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });

    await harness.service.refreshNow();

    expect(publishCredentials).toHaveBeenCalledTimes(1);
    expect(harness.authProfiles.upsertCodexProfile.mock.invocationCallOrder[0]).toBeLessThan(
      publishCredentials.mock.invocationCallOrder[0],
    );
  });

  it("replays a refresh publication when the gateway becomes ready", async () => {
    const publishCredentials = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("gateway starting"), {
          code: "runtime_starting",
        }),
      )
      .mockResolvedValue(undefined);
    const harness = createHarness({
      publishCredentials,
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });

    await expect(harness.service.refreshNow()).rejects.toMatchObject({
      code: "runtime_starting",
    });
    expect(harness.getProfile()?.access).toBe("broker-access");
    expect(harness.getAccessPublicationPending()).toBe(true);

    const retry = await harness.service.retryPendingLifecycle();

    expect(retry.accessPublication).toEqual({
      pending: false,
      published: true,
    });
    expect(harness.getAccessPublicationPending()).toBe(false);
    expect(publishCredentials).toHaveBeenCalledTimes(2);
    expect(harness.brokerClient.getCodexAccessToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the durable grant contained and retries when runtime publication fails", async () => {
    const publishCredentials = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("reload failed"), {
        code: "runtime_reload_failed",
      }));
    const harness = createHarness({ publishCredentials });
    await harness.service.start();

    await expect(
      harness.service.storeTokens({
        access: "access",
        refresh: "durable-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toThrow("reload failed");

    expect(harness.getProfile()?.refresh).toBe(CODEX_BROKER_REFRESH_PLACEHOLDER);
    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      state: "degraded",
      lastErrorCode: "runtime_reload_failed",
    });
    expect(harness.timers.at(-1).delay).toBe(60 * 1000);
  });

  it("finalizes a pending deposit journal before rotating its access token", async () => {
    const publishCredentials = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("reload failed"), {
          code: "runtime_reload_failed",
        }),
      )
      .mockResolvedValue(undefined);
    const harness = createHarness({ publishCredentials });

    await expect(
      harness.service.storeTokens({
        access: "deposited-access",
        refresh: "durable-refresh",
        expires: 1_700_003_600_000,
      }),
    ).rejects.toThrow("reload failed");

    await harness.service.refreshNow();

    expect(harness.getDepositPending()).toBe(false);
    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
    expect(publishCredentials).toHaveBeenCalledTimes(3);
    expect(publishCredentials.mock.invocationCallOrder[1]).toBeLessThan(
      harness.brokerClient.getCodexAccessToken.mock.invocationCallOrder[0],
    );
    expect(harness.getProfile()?.access).toBe("broker-access");
  });

  it("serializes disconnect behind an in-flight refresh", async () => {
    let release;
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });
    harness.brokerClient.getCodexAccessToken.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    const refresh = harness.service.refreshNow();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const disconnect = harness.service.disconnect();
    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
    release({
      access_token: "new",
      expires_at: 1_700_003_600,
      scopes: [],
      scopes_known: true,
      refreshed: true,
    });
    await refresh;
    await disconnect;

    expect(harness.getProfile()).toBeNull();
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
  });

  it("revokes an uncommitted deposit journal during startup recovery", async () => {
    const harness = createHarness({ depositPending: true });

    await harness.service.start();

    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.getDepositPending()).toBe(false);
  });

  it("finalizes a committed deposit journal without revoking its grant", async () => {
    const harness = createHarness({
      depositPending: true,
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_000_100_000,
      },
    });

    await harness.service.start();

    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
    expect(harness.getDepositPending()).toBe(false);
  });

  it("removes the local profile even when gateway revocation is unavailable", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    harness.brokerClient.revokeCodexGrant.mockRejectedValue(
      Object.assign(new Error("down"), { code: "ssh_failed" }),
    );

    const result = await harness.service.disconnect();

    expect(result).toEqual({
      ok: false,
      changed: true,
      brokered: true,
      error: "ssh_failed",
      revocationPending: true,
    });
    expect(harness.getProfile()).toBeNull();
    expect(harness.service.getStatus().revocationPending).toBe(true);
    expect(harness.publishCredentials).toHaveBeenCalledTimes(1);
    expect(harness.publishCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      harness.brokerClient.revokeCodexGrant.mock.invocationCallOrder[0],
    );
  });

  it("keeps the profile when revocation intent cannot be journaled", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    const service = createCodexBrokerService({
      brokerClient: harness.brokerClient,
      authProfiles: harness.authProfiles,
      clientId: "client-id",
      scopes: ["openid"],
      getCodexAccountId: vi.fn(),
      logger: { error: vi.fn() },
      pendingRevocationStore: {
        isPending: () => false,
        mark: () => {
          throw new Error("read-only filesystem");
        },
        clear: vi.fn(),
      },
      pendingDepositStore: {
        isPending: () => false,
        mark: vi.fn(),
        clear: vi.fn(),
      },
    });

    const result = await service.disconnect();

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      error: "revocation_marker_unavailable",
    });
    expect(harness.getProfile()).not.toBeNull();
    expect(harness.brokerClient.revokeCodexGrant).not.toHaveBeenCalled();
  });

  it("still revokes remotely when publishing the local disconnect fails", async () => {
    const publishCredentials = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("reload failed"), {
        code: "runtime_reload_failed",
      }));
    const harness = createHarness({
      publishCredentials,
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });

    const result = await harness.service.disconnect();

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      error: "runtime_reload_failed",
      revocationPending: true,
    });
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.getProfile()).toBeNull();
  });

  it("keeps revocation pending when local profile deletion fails", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    harness.authProfiles.removeCodexProfiles.mockImplementationOnce(() => {
      throw Object.assign(new Error("database locked"), { code: "sqlite_busy" });
    });

    const result = await harness.service.disconnect();

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      error: "sqlite_busy",
      revocationPending: true,
    });
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.getProfile()).not.toBeNull();
    expect(harness.publishCredentials).toHaveBeenCalledTimes(1);
  });

  it("publishes a committed deletion even when later local cleanup throws", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    const remove = harness.authProfiles.removeCodexProfiles.getMockImplementation();
    harness.authProfiles.removeCodexProfiles.mockImplementationOnce(() => {
      remove();
      throw Object.assign(new Error("cleanup failed after commit"), {
        code: "cleanup_failed",
      });
    });

    const result = await harness.service.disconnect();

    expect(result).toMatchObject({
      ok: false,
      error: "cleanup_failed",
      revocationPending: true,
    });
    expect(harness.getProfile()).toBeNull();
    expect(harness.publishCredentials).toHaveBeenCalledTimes(1);
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
  });

  it("durably retries an incomplete revocation after restart", async () => {
    let pending = true;
    const harness = createHarness();
    const service = createCodexBrokerService({
      brokerClient: harness.brokerClient,
      authProfiles: harness.authProfiles,
      clientId: "client-id",
      scopes: ["openid"],
      getCodexAccountId: vi.fn(),
      setIntervalFn: () => ({ unref: vi.fn() }),
      clearIntervalFn: vi.fn(),
      logger: { error: vi.fn() },
      pendingRevocationStore: {
        isPending: () => pending,
        mark: () => {
          pending = true;
        },
        clear: () => {
          pending = false;
        },
      },
      pendingDepositStore: {
        isPending: () => false,
        mark: vi.fn(),
        clear: vi.fn(),
      },
    });

    await service.start();

    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(pending).toBe(false);
  });

  it("durably retries runtime removal after a legacy disconnect", async () => {
    const publishCredentials = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("reload failed"), {
          code: "runtime_reload_failed",
        }),
      )
      .mockResolvedValue(undefined);
    const harness = createHarness({
      configured: false,
      publishCredentials,
      profile: {
        type: "oauth",
        provider: "openai",
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: 1_700_003_600_000,
      },
    });

    const result = await harness.service.disconnect();

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      publicationPending: true,
      error: "runtime_reload_failed",
    });
    expect(harness.getProfile()).toBeNull();
    expect(harness.getPublicationPending()).toBe(true);

    await expect(harness.service.retryPendingPublication()).resolves.toEqual({
      pending: false,
      changed: false,
    });
    expect(harness.getPublicationPending()).toBe(false);
    expect(publishCredentials).toHaveBeenCalledTimes(2);
  });

  it("sweeps hidden local artifacts when no primary profile is loaded", async () => {
    const harness = createHarness({ configured: false, profile: null });

    const result = await harness.service.disconnect();

    expect(result).toEqual({
      ok: true,
      changed: false,
      brokered: false,
    });
    expect(harness.authProfiles.removeCodexProfiles).toHaveBeenCalledTimes(1);
    expect(harness.publishCredentials).toHaveBeenCalledTimes(1);
  });

  it("revokes an ambiguous deposit when disconnect has no primary profile", async () => {
    const harness = createHarness({ depositPending: true, profile: null });

    const result = await harness.service.disconnect();

    expect(result).toMatchObject({ ok: true, brokered: true });
    expect(harness.brokerClient.revokeCodexGrant).toHaveBeenCalledTimes(1);
    expect(harness.getDepositPending()).toBe(false);
  });

  it("surfaces a missing gateway grant as reconnect-required", async () => {
    const harness = createHarness({
      profile: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: CODEX_BROKER_REFRESH_PLACEHOLDER,
        expires: 1_700_003_600_000,
      },
    });
    harness.brokerClient.status.mockResolvedValue({
      denied: false,
      kek_present: true,
      grants: [],
    });

    await harness.service.checkHealth();

    expect(harness.service.getStatus()).toMatchObject({
      state: "degraded",
      lastErrorCode: "grant_not_found",
      reconnectRequired: true,
    });
  });
});
