const express = require("express");
const request = require("supertest");

const {
  parseClaudeAuthStatus,
  registerAccountLoginRoutes,
} = require("../../lib/server/routes/account-logins");

const createApp = ({
  shellCmd = vi.fn(),
  configured = false,
  upsertClaudeCliProfile = vi.fn(() => {
    configured = true;
  }),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerAccountLoginRoutes({
    app,
    shellCmd,
    gatewayEnv: () => ({ HOME: "/tmp/alphaclaw" }),
    authProfiles: {
      hasClaudeCliProfile: vi.fn(() => configured),
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

  it("returns Claude CLI status when installed and logged in", async () => {
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "command -v claude") return "/usr/local/bin/claude\n";
      if (cmd === "claude --version") return "2.1.170 (Claude Code)\n";
      if (cmd === "claude auth status --text") {
        return "Login method: Claude Max account\nEmail: user@example.com\n";
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
      if (cmd === "claude auth status --text") {
        return "Login method: Claude Max account\nEmail: user@example.com\n";
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
      if (cmd === "claude auth status --text") throw new Error("not logged in");
      return "";
    });
    const upsertClaudeCliProfile = vi.fn();
    const { app } = createApp({ shellCmd, upsertClaudeCliProfile });

    const res = await request(app).post("/api/account-logins/claude-cli/adopt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Run Claude CLI login before adopting Claude CLI reuse");
    expect(upsertClaudeCliProfile).not.toHaveBeenCalled();
  });
});
