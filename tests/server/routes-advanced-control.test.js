const express = require("express");
const request = require("supertest");

const {
  createAdvancedControlAccessService,
} = require("../../lib/server/advanced-control-access");
const {
  registerAdvancedControlRoutes,
} = require("../../lib/server/routes/advanced-control");
const { registerAuthRoutes } = require("../../lib/server/routes/auth");

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const createApp = () => {
  process.env.SETUP_PASSWORD = "test-secret";
  const acknowledgements = [];
  const app = express();
  app.use(express.json());
  const { requireAuth, getAuthorizedSession } = registerAuthRoutes({
    app,
    loginThrottle: createLoginThrottleMock(),
  });
  const service = createAdvancedControlAccessService({
    secret: "test-secret",
    getAuthorizedSession,
    env: { OPENCLAW_INSTANCE_ID: "oc_inst_test" },
    now: () => Date.parse("2026-09-18T16:30:00.000Z"),
    insertAcknowledgement: (entry) => {
      acknowledgements.push({ id: acknowledgements.length + 1, ...entry });
      return acknowledgements.length;
    },
    listAcknowledgements: () => acknowledgements,
  });
  const { requireAdvancedControlAccess } = registerAdvancedControlRoutes({
    app,
    requireAuth,
    service,
  });
  app.get(
    "/openclaw",
    requireAuth,
    requireAdvancedControlAccess,
    (_req, res) => res.json({ ok: true }),
  );
  app.get(
    "/openclaw/settings/general",
    requireAuth,
    requireAdvancedControlAccess,
    (_req, res) => res.json({ ok: true }),
  );
  app.get(
    "/openclaw/*",
    requireAuth,
    requireAdvancedControlAccess,
    (_req, res) => res.json({ ok: true }),
  );
  return { app, acknowledgements };
};

describe("server/routes/advanced-control", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("requires an authenticated, signed acknowledgement for direct and deep links", async () => {
    const { app } = createApp();
    const agent = request.agent(app);

    const anonymous = await agent
      .get("/openclaw/settings/general")
      .set("Accept", "text/html");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toBe("/login.html");

    await agent.post("/api/auth/login").send({ password: "test-secret" }).expect(200);
    const gated = await agent
      .get("/openclaw/settings/general?tab=models")
      .set("Accept", "text/html");
    expect(gated.status).toBe(302);
    expect(gated.headers.location).toContain("/advanced-control/access?returnTo=");

    const interstitial = await agent.get(gated.headers.location);
    expect(interstitial.status).toBe(200);
    expect(interstitial.text).toContain("TeamYou managed OpenClaw");
    expect(interstitial.text).toContain("Advanced — unmanaged changes");
    expect(interstitial.text).not.toContain("Starfoundry");
  });

  it("serves the page warning script only behind the acknowledgement", async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ password: "test-secret" }).expect(200);

    const gated = await agent.get("/openclaw/_teamyou/advanced-control.js");
    expect(gated.status).not.toBe(200);

    await agent
      .post("/api/advanced-control/acknowledge")
      .send({ returnTo: "/openclaw" })
      .expect(200);
    const script = await agent.get("/openclaw/_teamyou/advanced-control.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.text).toContain("/#/general");
    expect(script.text).toContain("/#/models");
    expect(script.text).toContain("/#/credentials");
  });

  it("records the audit fields and binds the acknowledgement to the login session", async () => {
    const { app, acknowledgements } = createApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ password: "test-secret" }).expect(200);

    const before = await agent.get("/api/advanced-control/status");
    expect(before.body).toMatchObject({
      ok: true,
      acknowledged: false,
      instanceId: "oc_inst_test",
      warningVersion: "teamyou.advanced-control-warning/v2",
      managedConfigRevision: "2026-09-22.1",
    });

    const acknowledgement = await agent
      .post("/api/advanced-control/acknowledge")
      .set("Tailscale-User-Login", "person@example.com")
      .send({ returnTo: "/openclaw/settings/general?tab=models" });
    expect(acknowledgement.status).toBe(200);
    expect(acknowledgement.body).toMatchObject({
      ok: true,
      acknowledged: true,
      auditId: 1,
      url: "/openclaw/settings/general?tab=models",
    });
    expect(acknowledgements).toEqual([
      expect.objectContaining({
        userIdentity: "person@example.com",
        instanceId: "oc_inst_test",
        warningVersion: "teamyou.advanced-control-warning/v2",
        managedConfigRevision: "2026-09-22.1",
        acknowledgedAt: "2026-09-18T16:30:00.000Z",
      }),
    ]);

    await agent.get("/openclaw/settings/general").expect(200);
    expect((await agent.get("/api/advanced-control/status")).body.acknowledged).toBe(true);

    await agent.post("/api/auth/login").send({ password: "test-secret" }).expect(200);
    const replacedSession = await agent
      .get("/openclaw")
      .set("Accept", "text/html");
    expect(replacedSession.status).toBe(302);
    expect(replacedSession.headers.location).toContain("/advanced-control/access");
  });

  it("rejects API bypasses and prevents open redirects", async () => {
    const { app } = createApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ password: "test-secret" }).expect(200);

    const blocked = await agent.get("/openclaw/control-ui-config.json");
    expect(blocked.status).toBe(403);

    const formResponse = await agent.post(
      "/advanced-control/access?returnTo=https%3A%2F%2Fevil.example%2F",
    );
    expect(formResponse.status).toBe(303);
    expect(formResponse.headers.location).toBe("/openclaw");
  });
});
