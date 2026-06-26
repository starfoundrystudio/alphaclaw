const express = require("express");
const request = require("supertest");

const {
  getCodexReconnectStatusFromLogs,
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
