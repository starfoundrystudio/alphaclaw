const fs = require("fs");
const os = require("os");
const path = require("path");

const { createGogBrokerService } = require("../../lib/server/gog-broker-service");
const {
  createEmptyGoogleState,
  readGoogleState,
  writeGoogleState,
} = require("../../lib/server/google-state");

const kNowMs = 1_700_000_000_000;

const createHarness = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gog-broker-"));
  const statePath = path.join(root, "gogcli", "state.json");
  const markerDir = path.join(root, "oauth-broker");
  const credentialsPath = (client = "default") =>
    path.join(root, "gogcli", `credentials-${client}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    credentialsPath(),
    JSON.stringify({ web: { client_id: "client", client_secret: "secret" } }),
    { mode: 0o600 },
  );
  writeGoogleState({ fs, statePath, state: createEmptyGoogleState() });
  const brokerClient = {
    isConfigured: vi.fn(() => true),
    depositGogGrant: vi.fn(async () => true),
    getGogAccessToken: vi.fn(async () => ({
      access_token: "leased-access",
      expires_at: Math.floor(kNowMs / 1000) + 3600,
      scopes: ["openid"],
      scopes_known: true,
    })),
    revokeGogGrant: vi.fn(async () => ({ revoked: true })),
  };
  const gogCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
  const service = createGogBrokerService({
    brokerClient,
    gogCmd,
    readState: () => readGoogleState({ fs, statePath }),
    saveState: (state) => writeGoogleState({ fs, statePath, state }),
    readGoogleCredentials: () => ({
      clientId: "client",
      clientSecret: "secret",
    }),
    gogClientCredentialsPath: credentialsPath,
    resolveOAuthScopes: () => ["openid"],
    markerDir,
    migrationTempDir: markerDir,
    fsModule: fs,
    isManagedInstance: () => true,
    now: () => kNowMs,
    logger: { error: vi.fn() },
  });
  return {
    brokerClient,
    credentialsPath,
    gogCmd,
    markerDir,
    root,
    service,
    statePath,
  };
};

const account = {
  id: "account-1",
  email: "owner@example.com",
  client: "default",
  personal: false,
  services: ["gmail:read"],
  authenticated: true,
};

describe("server/gog-broker-service", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deposits into a fixed slot, verifies a lease, then removes local OAuth state", async () => {
    const harness = createHarness();
    roots.push(harness.root);

    await expect(
      harness.service.adoptGrant({
        account,
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "durable-refresh",
        scopes: ["openid"],
      }),
    ).resolves.toMatchObject({ brokered: true, consumer: "gog-1" });

    expect(harness.brokerClient.depositGogGrant).toHaveBeenCalledWith({
      consumer: "gog-1",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "durable-refresh",
      scopes: ["openid"],
    });
    expect(readGoogleState({ fs, statePath: harness.statePath }).accounts[0]).toMatchObject({
      brokerConsumer: "gog-1",
      authenticated: true,
    });
    expect(fs.existsSync(harness.credentialsPath())).toBe(false);
    expect(harness.gogCmd).toHaveBeenCalledWith(
      'auth remove "owner@example.com" --force',
      { quiet: true, authBypass: true },
    );
  });

  it("recovers an ambiguous deposit by revoking the slot and retaining local credentials", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    harness.brokerClient.depositGogGrant.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { code: "timeout" }),
    );

    await expect(
      harness.service.adoptGrant({
        account,
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "durable-refresh",
        scopes: ["openid"],
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(fs.existsSync(harness.credentialsPath())).toBe(true);

    await harness.service.start();
    expect(harness.brokerClient.revokeGogGrant).toHaveBeenCalledWith({
      consumer: "gog-1",
    });
    expect(
      fs.existsSync(path.join(harness.markerDir, "gog-1-deposit-pending.json")),
    ).toBe(false);
    expect(fs.existsSync(harness.credentialsPath())).toBe(true);
  });

  it("keeps shared client credentials until every configured account is brokered", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    const second = {
      ...account,
      id: "account-2",
      email: "second@example.com",
      authenticated: false,
    };
    writeGoogleState({
      fs,
      statePath: harness.statePath,
      state: { ...createEmptyGoogleState(), accounts: [account, second] },
    });

    await harness.service.adoptGrant({
      account,
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-one",
      scopes: ["openid"],
    });
    expect(fs.existsSync(harness.credentialsPath())).toBe(true);

    await harness.service.adoptGrant({
      account: second,
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-two",
      scopes: ["openid"],
    });
    const state = readGoogleState({ fs, statePath: harness.statePath });
    expect(state.accounts.map((item) => item.brokerConsumer)).toEqual([
      "gog-1",
      "gog-2",
    ]);
    expect(fs.existsSync(harness.credentialsPath())).toBe(false);
  });

  it("removes the account locally before retrying a failed gateway revocation", async () => {
    const harness = createHarness();
    roots.push(harness.root);
    const adopted = await harness.service.adoptGrant({
      account,
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "durable-refresh",
      scopes: ["openid"],
    });
    const brokeredAccount = {
      ...account,
      authenticated: true,
      brokerConsumer: adopted.consumer,
    };
    harness.brokerClient.revokeGogGrant.mockRejectedValueOnce(
      Object.assign(new Error("unavailable"), { code: "broker_unavailable" }),
    );

    await expect(
      harness.service.disconnect({ account: brokeredAccount }),
    ).resolves.toMatchObject({ revocationPending: true });
    expect(readGoogleState({ fs, statePath: harness.statePath }).accounts).toEqual([]);

    await harness.service.start();
    expect(harness.brokerClient.revokeGogGrant).toHaveBeenCalledTimes(2);
    expect(
      fs.existsSync(path.join(harness.markerDir, "gog-1-revocation-pending.json")),
    ).toBe(false);
  });
});
