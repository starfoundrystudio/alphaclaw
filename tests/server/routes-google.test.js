const express = require("express");
const request = require("supertest");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");

const createApp = ({
  readGoogleCredentials = () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
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
    gogCmd: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
    getSetupBaseUrl: () => "https://setup.tail123.ts.net",
    getPublicBaseUrl: () => "https://callbacks.example.com",
    readGoogleCredentials,
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
    expect(response.text).toContain("google: 'error'");
    expect(response.text).toContain("access_denied");
    expect(response.text).not.toContain("/setup?google=error");
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
