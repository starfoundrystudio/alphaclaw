const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createClaudeBrokerService,
  readClaudeCredential,
  sanitizeClaudeCredential,
} = require("../../lib/server/claude-broker-service");

const kNowMs = 1_700_000_000_000;

const writeCredential = (credentialsPath, refreshToken = "durable-refresh") => {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(
    credentialsPath,
    `${JSON.stringify(
      {
        unrelated: { keep: true },
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken,
          expiresAt: kNowMs + 60_000,
          scopes: ["user:inference"],
          subscriptionType: "max",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
};

const createHarness = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-claude-broker-"));
  const credentialsPath = path.join(root, ".claude", ".credentials.json");
  const markerDir = path.join(root, ".alphaclaw", "oauth-broker");
  let profile = null;
  const authProfiles = {
    getClaudeCliProfile: vi.fn(() => profile),
    hasClaudeCliProfile: vi.fn(() => !!profile),
    removeClaudeCliProfile: vi.fn(() => {
      const changed = !!profile;
      profile = null;
      return changed;
    }),
    upsertClaudeCliProfile: vi.fn((value) => {
      profile = { provider: "claude-cli", ...value };
    }),
  };
  const brokerClient = {
    isConfigured: vi.fn(() => true),
    status: vi.fn(async () => ({
      grants: [{ consumer: "claude-cli", provider: "anthropic" }],
    })),
    depositClaudeGrant: vi.fn(async () => true),
    getClaudeAccessToken: vi.fn(async () => ({
      access_token: "leased-access",
      expires_at: Math.floor(kNowMs / 1000) + 3600,
      scopes: ["user:inference"],
      scopes_known: true,
    })),
    revokeClaudeGrant: vi.fn(async () => ({ revoked: true })),
  };
  const service = createClaudeBrokerService({
    brokerClient,
    authProfiles,
    credentialsPath,
    markerDir,
    isManagedInstance: () => true,
    now: () => kNowMs,
    logger: { error: vi.fn() },
  });
  return {
    authProfiles,
    brokerClient,
    credentialsPath,
    markerDir,
    root,
    service,
    getProfile: () => profile,
  };
};

describe("server/claude-broker-service", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads and sanitizes only the Claude OAuth credential", () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);

    const credential = readClaudeCredential({
      credentialsPath: harness.credentialsPath,
    });
    expect(credential.refreshToken).toBe("durable-refresh");

    const result = sanitizeClaudeCredential({
      credentialsPath: harness.credentialsPath,
      expectedRefreshSha256: crypto
        .createHash("sha256")
        .update("durable-refresh")
        .digest("hex"),
    });

    expect(result).toEqual({ changed: true });
    const stored = JSON.parse(fs.readFileSync(harness.credentialsPath, "utf8"));
    expect(stored).toEqual({ unrelated: { keep: true } });
    expect(fs.statSync(harness.credentialsPath).mode & 0o777).toBe(0o600);
  });

  it("discards a partial unadopted Claude login without touching unrelated state", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    fs.mkdirSync(path.dirname(harness.credentialsPath), { recursive: true });
    fs.writeFileSync(
      harness.credentialsPath,
      JSON.stringify({
        unrelated: { keep: true },
        claudeAiOauth: { accessToken: "partial-access" },
      }),
      { mode: 0o600 },
    );

    await expect(harness.service.discardPendingLogin()).resolves.toEqual({
      changed: true,
    });

    expect(
      JSON.parse(fs.readFileSync(harness.credentialsPath, "utf8")),
    ).toEqual({ unrelated: { keep: true } });
  });

  it("preserves Claude credentials when an adopted profile already exists", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);
    harness.authProfiles.upsertClaudeCliProfile({ brokered: true });

    await expect(harness.service.discardPendingLogin()).resolves.toEqual({
      changed: false,
      preserved: true,
    });

    expect(
      readClaudeCredential({ credentialsPath: harness.credentialsPath }),
    ).toMatchObject({ refreshToken: "durable-refresh" });
  });

  it("deposits the refresh grant before removing it from the workload", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);

    await expect(
      harness.service.adopt({
        email: "owner@example.com",
        loginMethod: "claude.ai",
      }),
    ).resolves.toEqual({ brokered: true });

    expect(harness.brokerClient.depositClaudeGrant).toHaveBeenCalledWith({
      refreshToken: "durable-refresh",
    });
    expect(harness.brokerClient.getClaudeAccessToken).toHaveBeenCalledTimes(1);
    expect(harness.getProfile()).toMatchObject({
      brokered: true,
      email: "owner@example.com",
      loginMethod: "claude.ai",
    });
    expect(
      JSON.parse(fs.readFileSync(harness.credentialsPath, "utf8")),
    ).toEqual({ unrelated: { keep: true } });
    expect(
      fs.existsSync(path.join(harness.markerDir, "claude-deposit-pending.json")),
    ).toBe(false);
  });

  it("recovers an ambiguous deposit by revoking it and retaining the local login", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);
    const timeout = Object.assign(new Error("timed out"), { code: "timeout" });
    harness.brokerClient.depositClaudeGrant.mockRejectedValueOnce(timeout);

    await expect(harness.service.adopt()).rejects.toMatchObject({ code: "timeout" });
    const markerPath = path.join(
      harness.markerDir,
      "claude-deposit-pending.json",
    );
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8")).phase).toBe(
      "prepared",
    );
    expect(readClaudeCredential({ credentialsPath: harness.credentialsPath })).toMatchObject({
      refreshToken: "durable-refresh",
    });

    await expect(harness.service.reconcilePendingDeposit()).resolves.toEqual({
      pending: false,
      revoked: true,
    });
    expect(harness.brokerClient.revokeClaudeGrant).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readClaudeCredential({ credentialsPath: harness.credentialsPath })).toMatchObject({
      refreshToken: "durable-refresh",
    });
  });

  it("finishes a deposited journal after access-token verification recovers", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);
    const unavailable = Object.assign(new Error("unavailable"), {
      code: "broker_unavailable",
    });
    harness.brokerClient.getClaudeAccessToken
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        access_token: "leased-access",
        expires_at: Math.floor(kNowMs / 1000) + 3600,
        scopes: ["user:inference"],
        scopes_known: true,
      });

    await expect(harness.service.adopt()).rejects.toMatchObject({
      code: "broker_unavailable",
    });
    const markerPath = path.join(
      harness.markerDir,
      "claude-deposit-pending.json",
    );
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8")).phase).toBe(
      "deposited",
    );

    await expect(harness.service.reconcilePendingDeposit()).resolves.toEqual({
      pending: false,
      committed: true,
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(harness.getProfile()).toMatchObject({ brokered: true });
    expect(
      JSON.parse(fs.readFileSync(harness.credentialsPath, "utf8")),
    ).toEqual({ unrelated: { keep: true } });
  });

  it("disconnects locally first and retains a retry marker until revocation succeeds", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);
    await harness.service.adopt();
    harness.brokerClient.revokeClaudeGrant.mockRejectedValueOnce(
      Object.assign(new Error("unavailable"), { code: "broker_unavailable" }),
    );

    await expect(harness.service.disconnect()).resolves.toMatchObject({
      ok: false,
      revocationPending: true,
      error: "broker_unavailable",
    });
    expect(harness.getProfile()).toBeNull();
    expect(
      fs.existsSync(
        path.join(harness.markerDir, "claude-revocation-pending.json"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(harness.credentialsPath, "utf8")),
    ).toEqual({ unrelated: { keep: true } });

    await expect(harness.service.retryPendingRevocation()).resolves.toEqual({
      pending: false,
    });
    expect(
      fs.existsSync(
        path.join(harness.markerDir, "claude-revocation-pending.json"),
      ),
    ).toBe(false);
  });

  it("preserves the legacy local credential when disconnecting an unmanaged install", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    writeCredential(harness.credentialsPath);
    harness.brokerClient.isConfigured.mockReturnValue(false);
    const service = createClaudeBrokerService({
      brokerClient: harness.brokerClient,
      authProfiles: harness.authProfiles,
      credentialsPath: harness.credentialsPath,
      markerDir: harness.markerDir,
      isManagedInstance: () => false,
      now: () => kNowMs,
      logger: { error: vi.fn() },
    });

    await expect(service.disconnect()).resolves.toMatchObject({
      ok: true,
      brokered: false,
      revocationPending: false,
    });
    expect(harness.brokerClient.revokeClaudeGrant).not.toHaveBeenCalled();
    expect(readClaudeCredential({ credentialsPath: harness.credentialsPath })).toMatchObject({
      refreshToken: "durable-refresh",
    });
  });
});
