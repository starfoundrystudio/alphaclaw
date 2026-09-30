const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const {
  createPublicIngressGuard,
} = require("../../lib/server/deployment-surface");
const {
  kIngressSurfaceHeader,
  registerPageRoutes,
} = require("../../lib/server/routes/pages");
const {
  getAdvancedControlCookieName,
  getSessionCookieName,
} = require("../../lib/server/auth/cookie-names");
const {
  createAdvancedControlAccessService,
} = require("../../lib/server/advanced-control-access");

const kSetupUrl = "https://abc123def456.teamyou.io";
const kTunnelEnv = {
  ALPHACLAW_INGRESS_MODE: "cloudflare_tunnel",
  ALPHACLAW_SETUP_URL: kSetupUrl,
  ALPHACLAW_PUBLIC_BASE_URL: "https://abc123def456-hooks.teamyou.io",
  ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP: "127.0.0.1",
};
const kTailscaleEnv = {
  ALPHACLAW_SETUP_URL: "https://alpha.tail123.ts.net",
  ALPHACLAW_PUBLIC_BASE_URL: "https://alpha.tail123.ts.net:8443",
  ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP: "127.0.0.1",
};

const loadAuthRoutes = () => {
  const modulePath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[modulePath];
  return require(modulePath);
};

const getSetCookies = (res) => res.headers["set-cookie"] || [];

describe("tunnel-mode hardening", () => {
  describe("/pages", () => {
    const createPagesApp = (env) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tunnel-pages-"));
      const openclawDir = path.join(root, ".openclaw");
      fs.mkdirSync(path.join(openclawDir, "pages"), { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "pages", "hello.html"), "<h1>Hi</h1>");
      const requireAuth = vi.fn((_req, res) =>
        res.status(401).type("text/plain").send("Unauthorized"),
      );
      const app = express();
      app.set("trust proxy", 1);
      app.use(createPublicIngressGuard({ env }));
      registerPageRoutes({
        app,
        requireAuth,
        isGatewayRunning: async () => true,
        fsModule: fs,
        openclawDir,
        env,
      });
      return { app, requireAuth };
    };
    const privateHeaders = (host) => ({
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
      [kIngressSurfaceHeader]: "private",
    });

    it("keeps the gateway-private bypass in Tailscale mode", async () => {
      const { app, requireAuth } = createPagesApp(kTailscaleEnv);
      const res = await request(app)
        .get("/pages/hello.html")
        .set(privateHeaders("alpha.tail123.ts.net"));
      expect(res.status).toBe(200);
      expect(requireAuth).not.toHaveBeenCalled();
    });

    it("always requires a session in tunnel mode", async () => {
      const { app, requireAuth } = createPagesApp(kTunnelEnv);
      const res = await request(app)
        .get("/pages/hello.html")
        .set(privateHeaders("abc123def456.teamyou.io"));
      expect(res.status).toBe(401);
      expect(requireAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe("cookie names", () => {
    it("uses __Host- names only in tunnel mode", () => {
      expect(getSessionCookieName({})).toBe("setup_token");
      expect(getAdvancedControlCookieName({})).toBe("alphaclaw_advanced_access");
      expect(getSessionCookieName(kTunnelEnv)).toBe("__Host-setup_token");
      expect(getAdvancedControlCookieName(kTunnelEnv)).toBe(
        "__Host-alphaclaw_advanced_access",
      );
    });

    const createAuthApp = (env) => {
      const { registerAuthRoutes } = loadAuthRoutes();
      const app = express();
      app.use(express.json());
      registerAuthRoutes({
        app,
        env: { SETUP_PASSWORD: "pw", ...env },
        loginThrottle: {
          getClientKey: () => "k",
          getOrCreateLoginAttemptState: () => ({}),
          evaluateLoginThrottle: () => ({ blocked: false }),
          recordLoginFailure: () => ({ locked: false }),
          recordLoginSuccess: () => {},
          cleanupLoginAttemptStates: () => {},
        },
      });
      app.get("/api/protected", (_req, res) => res.json({ ok: true }));
      return app;
    };

    it("sets, reads, and clears the __Host- session cookie in tunnel mode", async () => {
      const app = createAuthApp(kTunnelEnv);
      const login = await request(app).post("/api/auth/login").send({ password: "pw" });
      expect(login.status).toBe(200);
      const [cookie] = getSetCookies(login);
      expect(cookie).toMatch(/^__Host-setup_token=/);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Secure");
      expect(cookie).not.toMatch(/Domain=/i);

      const token = cookie.split(";")[0];
      const authorized = await request(app).get("/api/protected").set("Cookie", token);
      expect(authorized.status).toBe(200);

      // A sibling-planted legacy-name cookie is ignored in tunnel mode.
      const legacyValue = token.replace("__Host-setup_token=", "setup_token=");
      const legacy = await request(app).get("/api/protected").set("Cookie", legacyValue);
      expect(legacy.status).toBe(401);

      const logout = await request(app).post("/api/auth/logout").set("Cookie", token);
      const cleared = getSetCookies(logout);
      expect(cleared.some((entry) => entry.startsWith("__Host-setup_token=;"))).toBe(true);
      expect(
        cleared.some((entry) => entry.startsWith("__Host-alphaclaw_advanced_access=;")),
      ).toBe(true);
      for (const entry of cleared) expect(entry).toContain("Secure");
    });

    it("keeps the historical names in Tailscale mode", async () => {
      const app = createAuthApp({});
      const login = await request(app).post("/api/auth/login").send({ password: "pw" });
      const [cookie] = getSetCookies(login);
      expect(cookie).toMatch(/^setup_token=/);
      expect(cookie).not.toContain("Secure");
      const authorized = await request(app)
        .get("/api/protected")
        .set("Cookie", cookie.split(";")[0]);
      expect(authorized.status).toBe(200);
    });

    it("names and secures the advanced access cookie per mode", () => {
      const session = { sessionId: "s1", expiresAt: Date.now() + 60_000 };
      const tunnel = createAdvancedControlAccessService({
        secret: "secret",
        env: { ...kTunnelEnv, OPENCLAW_INSTANCE_ID: "inst_x" },
        getAuthorizedSession: () => session,
      });
      expect(tunnel.getCookieName()).toBe("__Host-alphaclaw_advanced_access");
      expect(tunnel.getCookieOptions({ secure: false, headers: {} })).toMatchObject({
        secure: true,
        path: "/",
      });
      const { token } = tunnel.acknowledge({ headers: {} });
      expect(
        tunnel.getStatus({
          headers: { cookie: `__Host-alphaclaw_advanced_access=${token}` },
        }).acknowledged,
      ).toBe(true);
      expect(
        tunnel.getStatus({ headers: { cookie: `alphaclaw_advanced_access=${token}` } })
          .acknowledged,
      ).toBe(false);

      const tailscale = createAdvancedControlAccessService({
        secret: "secret",
        env: { OPENCLAW_INSTANCE_ID: "inst_x" },
        getAuthorizedSession: () => session,
      });
      expect(tailscale.getCookieName()).toBe("alphaclaw_advanced_access");
      expect(tailscale.getCookieOptions({ secure: false, headers: {} }).secure).toBe(false);
    });
  });
});
