const { EventEmitter } = require("events");
const express = require("express");
const request = require("supertest");

const {
  createOriginGuard,
  getOwnOrigin,
  isOriginProtectedPath,
  isSameOriginOrAbsent,
} = require("../../lib/server/origin-guard");
const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");

const kOwnHost = "abc123def456.teamyou.io";
const kOwnOrigin = `https://${kOwnHost}`;
const kSiblingOrigin = "https://zzz999yyy888.teamyou.io";
const kGatewayHeaders = {
  "x-forwarded-host": kOwnHost,
  "x-forwarded-proto": "https",
};

const createApp = () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createOriginGuard());
  app.use(express.json());
  const ok = (req, res) => res.json({ ok: true, path: req.path });
  app.all("/api/*", ok);
  app.all("/setup/*", ok);
  app.all("/auth/*", ok);
  app.all("/openclaw/*", ok);
  app.all("/advanced-control/*", ok);
  app.all("/hooks/*", ok);
  app.all("/webhook/*", ok);
  app.all("/oauth/*", ok);
  app.all("/gmail-pubsub", ok);
  app.all("/v1/*", ok);
  app.all("/other", ok);
  return app;
};

describe("origin guard", () => {
  describe("helpers", () => {
    it("computes the request's own origin from the gateway headers", () => {
      expect(getOwnOrigin({ headers: kGatewayHeaders })).toBe(kOwnOrigin);
      expect(
        getOwnOrigin({ headers: { host: "localhost:3000" }, socket: {} }),
      ).toBe("http://localhost:3000");
      expect(
        getOwnOrigin({ headers: { host: "example.test" }, socket: { encrypted: true } }),
      ).toBe("https://example.test");
    });

    it("treats a missing Origin as allowed and null or foreign origins as refused", () => {
      expect(isSameOriginOrAbsent({ headers: kGatewayHeaders })).toBe(true);
      expect(
        isSameOriginOrAbsent({ headers: { ...kGatewayHeaders, origin: kOwnOrigin } }),
      ).toBe(true);
      expect(
        isSameOriginOrAbsent({
          headers: { ...kGatewayHeaders, origin: "HTTPS://ABC123DEF456.TEAMYOU.IO" },
        }),
      ).toBe(true);
      for (const origin of [
        kSiblingOrigin,
        "null",
        "http://abc123def456.teamyou.io",
        "https://abc123def456.teamyou.io:8443",
        "https://evil.abc123def456.teamyou.io",
        "garbage",
      ]) {
        expect(
          isSameOriginOrAbsent({ headers: { ...kGatewayHeaders, origin } }),
        ).toBe(false);
      }
    });

    it("protects the dashboard prefixes and exempts public callbacks", () => {
      for (const path of ["/api", "/api/onboard", "/setup/x", "/auth/logout", "/openclaw", "/openclaw/x", "/advanced-control/access"]) {
        expect(isOriginProtectedPath(path)).toBe(true);
      }
      for (const path of [
        "/auth/google/callback",
        "/auth/codex/callback",
        "/hooks/gmail",
        "/webhook/abc",
        "/oauth/abc",
        "/gmail-pubsub",
        "/v1/chat/completions",
        "/apix",
        "/pages/x",
        "/",
      ]) {
        expect(isOriginProtectedPath(path)).toBe(false);
      }
    });
  });

  describe("middleware", () => {
    it("refuses cross-origin state-changing requests to protected paths", async () => {
      const app = createApp();
      for (const [method, path] of [
        ["post", "/api/onboard"],
        ["put", "/api/env"],
        ["patch", "/setup/thing"],
        ["delete", "/api/channels/accounts"],
        ["post", "/auth/logout"],
        ["post", "/openclaw/api/x"],
        ["post", "/advanced-control/access"],
        ["post", "/API/Onboard"],
      ]) {
        const res = await request(app)[method](path)
          .set(kGatewayHeaders)
          .set("Origin", kSiblingOrigin);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body).toEqual({ ok: false, error: "Cross-origin request refused" });
      }
    });

    it("refuses the opaque null origin of sandboxed pages", async () => {
      const res = await request(createApp())
        .post("/api/onboard")
        .set(kGatewayHeaders)
        .set("Origin", "null");
      expect(res.status).toBe(403);
    });

    it("allows same-origin requests and requests without Origin", async () => {
      const app = createApp();
      const same = await request(app)
        .post("/api/onboard")
        .set(kGatewayHeaders)
        .set("Origin", kOwnOrigin);
      expect(same.status).toBe(200);
      const none = await request(app).post("/api/onboard").set(kGatewayHeaders);
      expect(none.status).toBe(200);
    });

    it("never blocks safe methods", async () => {
      const app = createApp();
      for (const method of ["get", "head", "options"]) {
        const res = await request(app)[method]("/api/status")
          .set(kGatewayHeaders)
          .set("Origin", kSiblingOrigin);
        expect(res.status, method).toBe(200);
      }
    });

    it("exempts public callbacks and the OpenAI-compatible API", async () => {
      const app = createApp();
      for (const path of [
        "/hooks/gmail",
        "/webhook/abc",
        "/oauth/abc",
        "/gmail-pubsub",
        "/auth/google/callback",
        "/auth/codex/callback",
        "/v1/chat/completions",
        "/other",
      ]) {
        const res = await request(app)
          .post(path)
          .set(kGatewayHeaders)
          .set("Origin", "https://accounts.google.com");
        expect(res.status, path).not.toBe(403);
      }
    });
  });

  describe("WebSocket upgrades", () => {
    const createHarness = () => {
      const server = new EventEmitter();
      const proxy = { ws: vi.fn() };
      const chatWsService = { handleUpgrade: vi.fn() };
      createWatchdogTerminalWsBridge({
        server,
        proxy,
        getGatewayUrl: () => "http://127.0.0.1:18789",
        isAuthorizedRequest: () => true,
        isAdvancedControlAuthorized: () => true,
        isRequestAllowedForSurface: () => true,
        watchdogTerminal: { createOrReuseSession: vi.fn() },
        chatWsService,
      });
      return { server, proxy, chatWsService };
    };
    const createSocket = () => ({ write: vi.fn(), destroy: vi.fn() });
    const upgrade = (harness, url, headers) => {
      const socket = createSocket();
      harness.server.emit(
        "upgrade",
        { url, method: "GET", headers: { ...kGatewayHeaders, ...headers } },
        socket,
        Buffer.alloc(0),
      );
      return socket;
    };

    it.each(["/api/ws/chat", "/api/watchdog/terminal/ws", "/openclaw"])(
      "refuses a cross-origin handshake on %s",
      (url) => {
        const harness = createHarness();
        const socket = upgrade(harness, url, { origin: kSiblingOrigin });
        expect(socket.write).toHaveBeenCalledWith(
          expect.stringContaining("403 Forbidden"),
        );
        expect(socket.destroy).toHaveBeenCalled();
        expect(harness.proxy.ws).not.toHaveBeenCalled();
        expect(harness.chatWsService.handleUpgrade).not.toHaveBeenCalled();
      },
    );

    it("accepts same-origin and Origin-less handshakes", () => {
      const harness = createHarness();
      upgrade(harness, "/api/ws/chat", { origin: kOwnOrigin });
      upgrade(harness, "/api/ws/chat", {});
      expect(harness.chatWsService.handleUpgrade).toHaveBeenCalledTimes(2);
      upgrade(harness, "/openclaw", { origin: kOwnOrigin });
      expect(harness.proxy.ws).toHaveBeenCalledTimes(1);
    });
  });
});
