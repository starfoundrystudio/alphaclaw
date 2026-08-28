const express = require("express");
const { EventEmitter } = require("events");
const { PassThrough, Writable } = require("stream");
const request = require("supertest");

const {
  parseClaudeAuthStatus,
  registerAccountLoginRoutes,
} = require("../../lib/server/routes/account-logins");

const createApp = ({
  shellCmd = vi.fn(),
  configured = false,
  loginProcesses,
  spawnFn,
  claudeBrokerService,
  upsertClaudeCliProfile = vi.fn(() => {
    configured = true;
  }),
  removeClaudeCliProfile = vi.fn(() => {
    const changed = configured;
    configured = false;
    return changed;
  }),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerAccountLoginRoutes({
    app,
    shellCmd,
    gatewayEnv: () => ({ HOME: "/tmp/alphaclaw" }),
    loginProcesses,
    spawnFn,
    claudeBrokerService,
    authProfiles: {
      getClaudeCliProfile: vi.fn(() => null),
      hasClaudeCliProfile: vi.fn(() => configured),
      removeClaudeCliProfile,
      upsertClaudeCliProfile,
    },
  });
  return { app, upsertClaudeCliProfile };
};

describe("server/routes/account-logins", () => {
  it("parses Claude CLI auth status text", () => {
    expect(
      parseClaudeAuthStatus(
        "Login method: Claude Max account\nEmail: user@example.com\nOrganization: Team",
      ),
    ).toMatchObject({
      loggedIn: true,
      email: "user@example.com",
      loginMethod: "Claude Max account",
    });
  });

  it("parses Claude CLI auth status JSON", () => {
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: false,
          authMethod: "none",
          apiProvider: "firstParty",
        }),
      ),
    ).toMatchObject({
      loggedIn: false,
      email: "",
      loginMethod: "none",
    });
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "user@example.com",
        }),
      ),
    ).toMatchObject({
      loggedIn: true,
      email: "user@example.com",
      loginMethod: "claude.ai",
    });
  });

  it("returns Claude CLI status when installed and logged in", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.170 (Claude Code)\n";
      if (cmd === "claude auth status --json 2>&1 || true") {
        return JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "user@example.com",
        });
      }
      return "";
    });
    const { app } = createApp({ shellCmd, configured: true });

    const res = await request(app).get("/api/account-logins/claude-cli/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      installed: true,
      loggedIn: true,
      configured: true,
      binary: "/usr/local/bin/claude",
      version: "2.1.170 (Claude Code)",
      email: "user@example.com",
    });
  });

  it("adopts Claude CLI after the CLI reports a logged-in account", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.170 (Claude Code)\n";
      if (cmd === "claude auth status --json 2>&1 || true") {
        return JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "user@example.com",
        });
      }
      return "";
    });
    const upsertClaudeCliProfile = vi.fn();
    const { app } = createApp({ shellCmd, upsertClaudeCliProfile });

    const res = await request(app).post("/api/account-logins/claude-cli/adopt");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.configured).toBe(true);
    expect(upsertClaudeCliProfile).toHaveBeenCalledTimes(1);
  });

  it("does not adopt Claude CLI before login succeeds", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.170 (Claude Code)\n";
      if (cmd === "claude auth status --json 2>&1 || true") {
        return JSON.stringify({
          loggedIn: false,
          authMethod: "none",
          apiProvider: "firstParty",
        });
      }
      return "";
    });
    const upsertClaudeCliProfile = vi.fn();
    const { app } = createApp({ shellCmd, upsertClaudeCliProfile });

    const res = await request(app).post("/api/account-logins/claude-cli/adopt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Run Claude CLI login before adopting Claude CLI reuse");
    expect(upsertClaudeCliProfile).not.toHaveBeenCalled();
  });

  it("sends a pasted Claude login code to the running CLI process", async () => {
    const writes = [];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    });
    const spawnFn = vi.fn(() => child);
    const { app } = createApp({ spawnFn });

    const startRes = await request(app)
      .post("/api/account-logins/claude-cli/login/start");

    expect(startRes.status).toBe(200);
    expect(startRes.body.ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.objectContaining({
        env: expect.objectContaining({
          ALPHACLAW_CLAUDE_LOGIN_BYPASS: "1",
        }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    const inputRes = await request(app)
      .post(`/api/account-logins/claude-cli/login/${startRes.body.id}/input`)
      .send({ input: "abc-123" });

    expect(inputRes.status).toBe(200);
    expect(inputRes.body.ok).toBe(true);
    expect(writes).toEqual(["abc-123\n"]);
  });

  it("adopts a logged-in Claude grant through the broker service", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.236 (Claude Code)\n";
      return JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "user@example.com",
      });
    });
    const claudeBrokerService = {
      adopt: vi.fn(async () => ({ brokered: true })),
      status: vi.fn(async () => ({
        configured: true,
        grantPresent: true,
        brokered: true,
      })),
    };
    const { app } = createApp({ shellCmd, claudeBrokerService });

    const res = await request(app).post("/api/account-logins/claude-cli/adopt");

    expect(res.status).toBe(200);
    expect(claudeBrokerService.adopt).toHaveBeenCalledWith({
      email: "user@example.com",
      loginMethod: "claude.ai",
    });
  });

  it("returns a retryable failure after local disconnect when broker revocation is pending", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.236 (Claude Code)\n";
      return JSON.stringify({ loggedIn: false, authMethod: "none" });
    });
    const claudeBrokerService = {
      disconnect: vi.fn(async () => ({
        ok: false,
        changed: true,
        brokered: true,
        revocationPending: true,
        error: "broker_unavailable",
      })),
      status: vi.fn(async () => ({
        configured: true,
        grantPresent: false,
        brokered: false,
        revocationPending: true,
      })),
    };
    const { app } = createApp({
      shellCmd,
      configured: true,
      claudeBrokerService,
    });

    const res = await request(app).post(
      "/api/account-logins/claude-cli/disconnect",
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      changed: true,
      revocationPending: true,
      error: "broker_unavailable",
      status: { configured: false, loggedIn: false },
    });
  });
});
