const express = require("express");
const request = require("supertest");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");

const createApp = ({
  readGoogleCredentials = () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
  gogBrokerService,
  gogCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerGoogleRoutes({
    app,
    fs: {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    isGatewayRunning: vi.fn(async () => true),
    gogCmd,
    getSetupBaseUrl: () => "https://setup.tail123.ts.net",
    getPublicBaseUrl: () => "https://callbacks.example.com",
    readGoogleCredentials,
    gogBrokerService,
    getApiEnableUrl: vi.fn(() => "https://console.cloud.google.com"),
    constants: {
      GOG_CONFIG_DIR: "/tmp/gogcli",
      GOG_STATE_PATH: "/tmp/gogcli/state.json",
      API_TEST_COMMANDS: {},
      BASE_SCOPES: [],
      SCOPE_MAP: {
        "gmail:read": "https://www.googleapis.com/auth/gmail.readonly",
      },
      REVERSE_SCOPE_MAP: {},
      kMaxGoogleAccounts: 5,
      gogClientCredentialsPath: () => "/tmp/gogcli/credentials.json",
      WORKSPACE_DIR: "/tmp/openclaw/workspace",
      OPENCLAW_DIR: "/tmp/openclaw",
    },
  });
  return app;
};

describe("server/routes/google", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the public callback URL as the Google OAuth redirect_uri", async () => {
    const app = createApp();

    const response = await request(app).get(
      "/auth/google/start?client=default&services=gmail:read",
    );

    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.location);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://callbacks.example.com/auth/google/callback",
    );
  });

  it("returns a lightweight popup error page for the public Google callback host", async () => {
    const app = createApp();

    const response = await request(app).get(
      "/auth/google/callback?error=access_denied",
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain("window.opener?.postMessage");
    expect(response.text).toContain('"google":"error"');
    expect(response.text).toContain("access_denied");
    expect(response.text).not.toContain("/setup?google=error");
  });

  it("deposits a Google refresh grant through the managed gog broker seam", async () => {
    const gogBrokerService = {
      isBrokeredMode: vi.fn(() => true),
      adoptGrant: vi.fn(async () => ({ consumer: "gog-1", brokered: true })),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "short-lived",
          refresh_token: "durable-refresh",
          scope: "openid https://www.googleapis.com/auth/gmail.readonly",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: "owner@example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ gogBrokerService });
    const startResponse = await request(app).get(
      "/auth/google/start?accountId=account-1&client=default&email=owner@example.com&services=gmail:read",
    );
    const oauthState = new URL(startResponse.headers.location).searchParams.get(
      "state",
    );

    const response = await request(app).get(
      `/auth/google/callback?code=authorization-code&state=${oauthState}`,
    );

    expect(response.text).toContain('"google":"success"');
    expect(gogBrokerService.adoptGrant).toHaveBeenCalledWith({
      account: expect.objectContaining({
        id: "account-1",
        email: "owner@example.com",
        authenticated: true,
      }),
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "durable-refresh",
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
    });
  });

  it("rejects consent for a different Google account than the one requested", async () => {
    const gogBrokerService = {
      isBrokeredMode: vi.fn(() => true),
      adoptGrant: vi.fn(),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "short-lived",
            refresh_token: "durable-refresh",
            scope: "openid",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: "other@example.com" }),
        }),
    );
    const app = createApp({ gogBrokerService });
    const startResponse = await request(app).get(
      "/auth/google/start?client=default&email=owner@example.com&services=gmail:read",
    );
    const oauthState = new URL(startResponse.headers.location).searchParams.get(
      "state",
    );

    const response = await request(app).get(
      `/auth/google/callback?code=authorization-code&state=${oauthState}`,
    );

    expect(response.text).toContain('"google":"error"');
    expect(response.text).toContain("other@example.com");
    expect(gogBrokerService.adoptGrant).not.toHaveBeenCalled();
  });

  it("fails closed when Google userinfo cannot bind the authorized account", async () => {
    const gogBrokerService = {
      isBrokeredMode: vi.fn(() => true),
      adoptGrant: vi.fn(),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "short-lived",
            refresh_token: "durable-refresh",
            scope: "openid",
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "invalid_token" }),
        }),
    );
    const app = createApp({ gogBrokerService });
    const startResponse = await request(app).get(
      "/auth/google/start?client=default&email=owner@example.com&services=gmail:read",
    );
    const oauthState = new URL(startResponse.headers.location).searchParams.get(
      "state",
    );

    const response = await request(app).get(
      `/auth/google/callback?code=authorization-code&state=${oauthState}`,
    );

    expect(response.text).toContain(
      "Google did not return the authorized account identity",
    );
    expect(gogBrokerService.adoptGrant).not.toHaveBeenCalled();
  });

  it("rejects unknown or replayed Google OAuth state before token exchange", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp();

    const response = await request(app).get(
      "/auth/google/callback?code=authorization-code&state=attacker-controlled",
    );

    expect(response.text).toContain("Google OAuth state is invalid or expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a newly entered gog client secret in the removable plaintext file", async () => {
    const gogCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const app = createApp({ gogCmd });

    const response = await request(app)
      .post("/api/google/credentials")
      .send({
        accountId: "account-1",
        client: "default",
        clientId: "client-id",
        clientSecret: "client-secret",
        email: "owner@example.com",
        services: ["gmail:read"],
      });

    expect(response.body.ok).toBe(true);
    expect(gogCmd).toHaveBeenCalledWith(
      expect.stringContaining("auth credentials set"),
      { quiet: true, authBypass: true },
    );
    expect(
      gogCmd.mock.calls.some(([command]) => command.includes("--insecure")),
    ).toBe(true);
  });

  describe("google provider endpoints", () => {
    const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;

    beforeEach(() => {
      delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    });

    afterEach(() => {
      if (typeof kOriginalProviderEnv === "undefined") {
        delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
        return;
      }
      process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
    });

    it("defaults to gog when no provider is configured", async () => {
      const app = createApp();

      const response = await request(app).get("/api/google/provider");

      expect(response.body).toEqual({
        ok: true,
        provider: "gog",
        source: "default",
        providers: ["gog", "composio", "none"],
      });
    });

    it("saves a valid provider and reports it as state-sourced", async () => {
      const app = createApp();

      const response = await request(app)
        .post("/api/google/provider")
        .send({ provider: "composio" });

      expect(response.body.ok).toBe(true);
      expect(response.body.provider).toBe("composio");
      expect(response.body.source).toBe("state");
    });

    it("rejects unknown provider values", async () => {
      const app = createApp();

      const response = await request(app)
        .post("/api/google/provider")
        .send({ provider: "gsuite" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("Invalid provider");
    });

    it("reports env-sourced provider when the override is set", async () => {
      process.env.ALPHACLAW_GOOGLE_PROVIDER = "none";
      const app = createApp();

      const response = await request(app).get("/api/google/provider");

      expect(response.body.provider).toBe("none");
      expect(response.body.source).toBe("env");
    });
  });
});
