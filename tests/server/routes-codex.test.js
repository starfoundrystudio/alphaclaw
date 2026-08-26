const express = require("express");
const request = require("supertest");

const {
  getCodexReconnectStatusFromLogs,
  parseCodexDeviceUsercodeResponse,
  registerCodexRoutes,
} = require("../../lib/server/routes/codex");

const createDeps = (overrides = {}) => ({
  createPkcePair: vi.fn(() => ({ verifier: "verifier", challenge: "challenge" })),
  parseCodexAuthorizationInput: vi.fn(() => ({ code: "code", state: "state" })),
  getCodexAccountId: vi.fn(() => "acct"),
  authProfiles: {
    getCodexProfile: vi.fn(() => null),
    upsertCodexProfile: vi.fn(),
    removeCodexProfiles: vi.fn(() => true),
  },
  readLogTail: vi.fn(() => ""),
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerCodexRoutes({
    app,
    ...deps,
  });
  return app;
};

describe("server/routes/codex", () => {
  it("returns disconnected status when no Codex OAuth profile exists", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/codex/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
    expect(deps.readLogTail).not.toHaveBeenCalled();
  });

  it("reports reconnect needed when recent logs contain Codex auth refresh failures", async () => {
    const deps = createDeps({
      authProfiles: {
        getCodexProfile: vi.fn(() => ({
          profileId: "openai:codex-cli",
          provider: "openai",
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: 9999999999999,
          updatedAt: Date.parse("2026-06-25T22:00:00.000Z"),
        })),
        upsertCodexProfile: vi.fn(),
        removeCodexProfiles: vi.fn(() => true),
      },
      readLogTail: vi.fn(
        () =>
          "2026-06-25T22:30:00.000Z Agent failed before reply: auth refresh request timed out after 10s\n",
      ),
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/codex/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        connected: true,
        needsReconnect: true,
        reconnectReason: "auth_refresh_failed",
        reconnectMessage: expect.stringContaining("Reconnect Codex OAuth"),
        updatedAt: Date.parse("2026-06-25T22:00:00.000Z"),
      }),
    );
    expect(res.body.lastReconnectFailure).toContain("auth refresh request timed out");
  });

  it("ignores auth refresh failures older than the latest Codex reconnect", async () => {
    const status = getCodexReconnectStatusFromLogs(
      [
        "2026-06-25T21:59:59.000Z Agent failed before reply: auth refresh request timed out after 10s",
        "2026-06-25T22:15:00.000Z Codex connected",
      ].join("\n"),
      { afterMs: Date.parse("2026-06-25T22:00:00.000Z") },
    );

    expect(status).toEqual({ needed: false, reason: null });
  });
});

describe("server/routes/codex device auth", () => {
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a 404 usercode response to the not-enabled reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
    const app = createApp(createDeps());

    const res = await request(app).post("/api/codex/device/start");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("not_enabled");
  });

  it("starts a device session and completes it after approval", async () => {
    const fetchMock = vi
      .fn()
      // start: usercode request
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_auth_id: "dev-auth-1",
          user_code: "ABCD-1234",
          interval: 7,
        }),
      )
      // poll 1: not approved yet
      .mockResolvedValueOnce(jsonResponse(403, {}))
      // poll 2: approved, server returns the code + PKCE verifier
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_code: "auth-code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      )
      // poll 2: token exchange
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const deps = createDeps();
    const app = createApp(deps);

    const startRes = await request(app).post("/api/codex/device/start");
    expect(startRes.status).toBe(200);
    expect(startRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        userCode: "ABCD-1234",
        verificationUrl: "https://auth.openai.com/codex/device",
        intervalMs: 7000,
      }),
    );
    const sessionId = startRes.body.sessionId;
    expect(sessionId).toBeTruthy();

    const pendingRes = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId });
    expect(pendingRes.body).toEqual({ ok: true, status: "pending" });

    const completeRes = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId });
    expect(completeRes.body).toEqual({ ok: true, status: "complete" });
    expect(deps.authProfiles.upsertCodexProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "access",
        refresh: "refresh",
        accountId: "acct",
      }),
    );

    const tokenExchangeCall = fetchMock.mock.calls[3];
    expect(tokenExchangeCall[0]).toBe("https://auth.openai.com/oauth/token");
    expect(String(tokenExchangeCall[1].body)).toContain(
      "redirect_uri=" +
        encodeURIComponent("https://auth.openai.com/deviceauth/callback"),
    );

    // The session is consumed after completion.
    const expiredRes = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId });
    expect(expiredRes.body).toEqual({ ok: true, status: "expired" });
  });

  it("reports expired for unknown device sessions", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const app = createApp(createDeps());

    const res = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId: "missing" });

    expect(res.body).toEqual({ ok: true, status: "expired" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces terminal poll failures as errors and drops the session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_auth_id: "dev-auth-1",
          usercode: "WXYZ-9876",
          interval: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(createDeps());

    const startRes = await request(app).post("/api/codex/device/start");
    expect(startRes.body.userCode).toBe("WXYZ-9876");
    expect(startRes.body.intervalMs).toBe(5000);

    const errorRes = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId: startRes.body.sessionId });
    expect(errorRes.body).toEqual({
      ok: true,
      status: "error",
      error: "Device auth polling failed (500)",
    });

    const expiredRes = await request(app)
      .post("/api/codex/device/poll")
      .send({ sessionId: startRes.body.sessionId });
    expect(expiredRes.body).toEqual({ ok: true, status: "expired" });
  });

  it("normalizes usercode response field aliases", () => {
    expect(
      parseCodexDeviceUsercodeResponse({
        deviceAuthId: "id",
        usercode: "CODE",
        interval: 5,
      }),
    ).toEqual({ deviceAuthId: "id", userCode: "CODE", intervalMs: 5000 });
    expect(parseCodexDeviceUsercodeResponse(null)).toEqual({
      deviceAuthId: "",
      userCode: "",
      intervalMs: 5000,
    });
  });
});
