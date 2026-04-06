const express = require("express");
const request = require("supertest");

const {
  createPublicIngressGuard,
  getConfiguredPublicPathPrefixes,
  isPublicPathAllowed,
  resolvePrivateUiBaseUrl,
  resolvePublicCallbackBaseUrl,
} = require("../../lib/server/deployment-surface");

const createGuardedApp = (env = {}) => {
  const app = express();
  app.use(createPublicIngressGuard({ env }));
  app.get("/", (req, res) => res.json({ ok: true, route: "/" }));
  app.get("/setup", (req, res) => res.json({ ok: true, route: "/setup" }));
  app.get("/login.html", (req, res) =>
    res.json({ ok: true, route: "/login.html" }),
  );
  app.post("/api/auth/login", (req, res) =>
    res.json({ ok: true, route: "/api/auth/login" }),
  );
  app.get("/api/private", (req, res) =>
    res.json({ ok: true, route: "/api/private" }),
  );
  app.get("/openclaw", (req, res) =>
    res.json({ ok: true, route: "/openclaw" }),
  );
  app.get("/assets/app.js", (req, res) =>
    res.json({ ok: true, route: "/assets/app.js" }),
  );
  app.get("/health", (req, res) =>
    res.json({ ok: true, route: "/health" }),
  );
  app.get("/hooks", (req, res) => res.json({ ok: true, route: "/hooks" }));
  app.all("/hooks/:name", (req, res) =>
    res.json({ ok: true, route: "/hooks/:name" }),
  );
  app.all("/webhook/:name", (req, res) =>
    res.json({ ok: true, route: "/webhook/:name" }),
  );
  app.all("/oauth/:id", (req, res) =>
    res.json({ ok: true, route: "/oauth/:id" }),
  );
  app.post("/gmail-pubsub", (req, res) =>
    res.json({ ok: true, route: "/gmail-pubsub" }),
  );
  app.get("/auth/google/callback", (req, res) =>
    res.json({ ok: true, route: "/auth/google/callback" }),
  );
  app.all("/googlechat", (req, res) =>
    res.json({ ok: true, route: "/googlechat" }),
  );
  app.all(/^\/api\/messages(?:\/.*)?$/, (req, res) =>
    res.json({ ok: true, route: "/api/messages" }),
  );
  return app;
};

const withOriginHeaders = (req, host) =>
  req.set("host", host).set("x-forwarded-proto", "https");

describe("server/deployment-surface", () => {
  it("keeps legacy routing behavior when the public callback URL is not configured", async () => {
    const app = createGuardedApp({
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
    });

    const response = await withOriginHeaders(
      request(app).get("/setup"),
      "callbacks.example.com",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, route: "/setup" });
  });

  it("allows the full UI surface on the private host in strict mode", async () => {
    const env = {
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
      ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com",
    };
    const app = createGuardedApp(env);

    const root = await withOriginHeaders(
      request(app).get("/"),
      "setup.tail123.ts.net",
    );
    const setup = await withOriginHeaders(
      request(app).get("/setup"),
      "setup.tail123.ts.net",
    );
    const login = await withOriginHeaders(
      request(app).post("/api/auth/login"),
      "setup.tail123.ts.net",
    );
    const privateApi = await withOriginHeaders(
      request(app).get("/api/private"),
      "setup.tail123.ts.net",
    );
    const gateway = await withOriginHeaders(
      request(app).get("/openclaw"),
      "setup.tail123.ts.net",
    );

    expect(root.status).toBe(200);
    expect(setup.status).toBe(200);
    expect(login.status).toBe(200);
    expect(privateApi.status).toBe(200);
    expect(gateway.status).toBe(200);
  });

  it("blocks non-callback routes on the public host in strict mode", async () => {
    const env = {
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
      ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com",
    };
    const app = createGuardedApp(env);

    const root = await withOriginHeaders(
      request(app).get("/"),
      "callbacks.example.com",
    );
    const setup = await withOriginHeaders(
      request(app).get("/setup"),
      "callbacks.example.com",
    );
    const loginPage = await withOriginHeaders(
      request(app).get("/login.html"),
      "callbacks.example.com",
    );
    const login = await withOriginHeaders(
      request(app).post("/api/auth/login"),
      "callbacks.example.com",
    );
    const health = await withOriginHeaders(
      request(app).get("/health"),
      "callbacks.example.com",
    );
    const assets = await withOriginHeaders(
      request(app).get("/assets/app.js"),
      "callbacks.example.com",
    );
    const hooksRoot = await withOriginHeaders(
      request(app).get("/hooks"),
      "callbacks.example.com",
    );

    expect(root.status).toBe(404);
    expect(setup.status).toBe(404);
    expect(loginPage.status).toBe(404);
    expect(login.status).toBe(404);
    expect(health.status).toBe(404);
    expect(assets.status).toBe(404);
    expect(hooksRoot.status).toBe(404);
  });

  it("allows only the built-in callback paths on the public host", async () => {
    const env = {
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
      ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com",
    };
    const app = createGuardedApp(env);

    const hooks = await withOriginHeaders(
      request(app).get("/hooks/foo"),
      "callbacks.example.com",
    );
    const webhook = await withOriginHeaders(
      request(app).post("/webhook/foo"),
      "callbacks.example.com",
    );
    const oauth = await withOriginHeaders(
      request(app).get("/oauth/test-callback"),
      "callbacks.example.com",
    );
    const gmail = await withOriginHeaders(
      request(app).post("/gmail-pubsub"),
      "callbacks.example.com",
    );
    const google = await withOriginHeaders(
      request(app).get("/auth/google/callback"),
      "callbacks.example.com",
    );

    expect(hooks.status).toBe(200);
    expect(webhook.status).toBe(200);
    expect(oauth.status).toBe(200);
    expect(gmail.status).toBe(200);
    expect(google.status).toBe(200);
  });

  it("returns 404 for unknown hosts in strict mode", async () => {
    const app = createGuardedApp({
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
      ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com",
    });

    const response = await withOriginHeaders(
      request(app).get("/hooks/foo"),
      "unexpected.example.com",
    );

    expect(response.status).toBe(404);
  });

  it("keeps extra public path prefixes blocked by default and allows them when configured", async () => {
    const baseEnv = {
      ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
      ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com",
    };
    const blockedApp = createGuardedApp(baseEnv);
    const allowedApp = createGuardedApp({
      ...baseEnv,
      ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES: "/googlechat,/api/messages",
    });

    const blockedGoogleChat = await withOriginHeaders(
      request(blockedApp).get("/googlechat"),
      "callbacks.example.com",
    );
    const blockedApiMessages = await withOriginHeaders(
      request(blockedApp).post("/api/messages"),
      "callbacks.example.com",
    );
    const allowedGoogleChat = await withOriginHeaders(
      request(allowedApp).get("/googlechat"),
      "callbacks.example.com",
    );
    const allowedApiMessages = await withOriginHeaders(
      request(allowedApp).post("/api/messages/provider"),
      "callbacks.example.com",
    );

    expect(blockedGoogleChat.status).toBe(404);
    expect(blockedApiMessages.status).toBe(404);
    expect(allowedGoogleChat.status).toBe(200);
    expect(allowedApiMessages.status).toBe(200);
  });

  it("resolves the private UI URL from the canonical setup URL first", () => {
    const result = resolvePrivateUiBaseUrl({
      env: {
        ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net/",
        ALPHACLAW_BASE_URL: "https://legacy.example.com",
      },
    });

    expect(result).toBe("https://setup.tail123.ts.net");
  });

  it("uses the configured public callback URL only when strict routing is enabled", () => {
    const strictResult = resolvePublicCallbackBaseUrl({
      env: {
        ALPHACLAW_SETUP_URL: "https://setup.tail123.ts.net",
        ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com/",
      },
      req: {
        headers: {
          host: "setup.tail123.ts.net",
          "x-forwarded-proto": "https",
        },
      },
    });
    const legacyResult = resolvePublicCallbackBaseUrl({
      env: {
        ALPHACLAW_PUBLIC_BASE_URL: "https://callbacks.example.com/",
      },
      req: {
        headers: {
          host: "setup.tail123.ts.net",
          "x-forwarded-proto": "https",
        },
      },
    });

    expect(strictResult).toBe("https://callbacks.example.com");
    expect(legacyResult).toBe("https://setup.tail123.ts.net");
  });

  it("treats Gmail and Google callback paths as exact matches and keeps extra prefixes normalized", () => {
    const env = {
      ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES:
        "/googlechat, invalid , /api/messages/ ",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(getConfiguredPublicPathPrefixes(env)).toEqual([
        "/googlechat",
        "/api/messages",
      ]);
      expect(isPublicPathAllowed("/gmail-pubsub", env)).toBe(true);
      expect(isPublicPathAllowed("/gmail-pubsub/extra", env)).toBe(false);
      expect(isPublicPathAllowed("/auth/google/callback", env)).toBe(true);
      expect(isPublicPathAllowed("/auth/google/callback/extra", env)).toBe(false);
      expect(isPublicPathAllowed("/hooks/example", env)).toBe(true);
      expect(isPublicPathAllowed("/hooks", env)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
