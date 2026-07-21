const express = require("express");
const request = require("supertest");

const { registerComposioRoutes } = require("../../lib/server/routes/composio");

const createApp = ({ composioCmd, files = new Map() } = {}) => {
  const app = express();
  app.use(express.json());
  registerComposioRoutes({
    app,
    fs: {
      existsSync: (p) => files.has(String(p)),
      readFileSync: (p) => {
        if (!files.has(String(p))) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return files.get(String(p));
      },
      writeFileSync: (p, data) => files.set(String(p), String(data)),
      mkdirSync: () => {},
      unlinkSync: () => {},
      copyFileSync: () => {},
    },
    constants: {
      OPENCLAW_DIR: "/openclaw",
      WORKSPACE_DIR: "/openclaw/workspace",
    },
    composioCmd:
      composioCmd || vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })),
    getSetupBaseUrl: () => "https://setup.example.com",
  });
  return app;
};

describe("server/routes/composio", () => {
  const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;
  const kOriginalApiKey = process.env.COMPOSIO_API_KEY;

  beforeEach(() => {
    delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    if (typeof kOriginalProviderEnv === "undefined") {
      delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    } else {
      process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
    }
    if (typeof kOriginalApiKey === "undefined") {
      delete process.env.COMPOSIO_API_KEY;
    } else {
      process.env.COMPOSIO_API_KEY = kOriginalApiKey;
    }
  });

  it("returns empty status with resolved provider when nothing is cached", async () => {
    const app = createApp();

    const response = await request(app).get("/api/composio/status");

    expect(response.body.ok).toBe(true);
    expect(response.body.provider).toBe("gog");
    expect(response.body.cliInstalled).toBe(false);
    expect(response.body.apiKeyConfigured).toBe(false);
    expect(response.body.googleAccounts).toEqual([]);
  });

  it("reports the env-resolved provider and API key presence", async () => {
    process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
    process.env.COMPOSIO_API_KEY = "ck_test";
    const app = createApp();

    const response = await request(app).get("/api/composio/status");

    expect(response.body.provider).toBe("composio");
    expect(response.body.providerSource).toBe("env");
    expect(response.body.apiKeyConfigured).toBe(true);
  });

  it("refresh runs the CLI, caches state, and returns linked accounts", async () => {
    process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
    const files = new Map();
    const composioCmd = vi.fn(async (cmd) => {
      if (cmd === "version") return { ok: true, stdout: "0.2.32", stderr: "" };
      if (cmd === "whoami") {
        return {
          ok: true,
          stdout: '{"account_type":"human","email":"bill@starfoundry.studio","current_org_name":"bill_workspace"}',
          stderr: "",
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify([
          { id: "ca_1", toolkit: { slug: "gmail" }, status: "ACTIVE" },
        ]),
        stderr: "",
      };
    });
    const app = createApp({ composioCmd, files });

    const refreshResponse = await request(app).post("/api/composio/refresh");

    expect(refreshResponse.body.ok).toBe(true);
    expect(refreshResponse.body.cliInstalled).toBe(true);
    expect(refreshResponse.body.account.email).toBe("bill@starfoundry.studio");
    expect(refreshResponse.body.googleAccounts).toHaveLength(1);
    expect(files.has("/openclaw/composio/state.json")).toBe(true);

    const statusResponse = await request(app).get("/api/composio/status");
    expect(statusResponse.body.cliInstalled).toBe(true);
    expect(statusResponse.body.googleAccounts).toHaveLength(1);
  });

  describe("link flow", () => {
    it("starts a link and returns the authorization URL", async () => {
      const composioCmd = vi.fn(async () => ({
        ok: true,
        stdout:
          "[1mAuthorize gmail:[22m\n  https://backend.composio.dev/s/AbC123\nWaiting is skipped (--no-wait).",
        stderr: "",
      }));
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail" });

      expect(response.body).toEqual({
        ok: true,
        toolkit: "gmail",
        redirectUrl: "https://backend.composio.dev/s/AbC123",
      });
      expect(composioCmd).toHaveBeenCalledWith(
        'link "gmail" --no-browser --no-wait',
        { quiet: true, timeoutMs: 60000 },
      );
    });

    it("rejects invalid toolkit slugs without shelling out", async () => {
      const composioCmd = vi.fn();
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail; rm -rf /" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("Invalid toolkit");
      expect(composioCmd).not.toHaveBeenCalled();
    });

    it("surfaces CLI output when no URL is returned", async () => {
      const composioCmd = vi.fn(async () => ({
        ok: true,
        stdout: "",
        stderr: "",
      }));
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("No authorization URL");
    });
  });
});
