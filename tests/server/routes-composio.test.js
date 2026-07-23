const express = require("express");
const request = require("supertest");

const { registerComposioRoutes } = require("../../lib/server/routes/composio");

const createFakeListenService = () => ({
  start: vi.fn(),
  stop: vi.fn(),
  enable: vi.fn(async () => ({ ok: true, pid: 4242, running: true })),
  disable: vi.fn(async () => ({ ok: true })),
  getStatus: vi.fn(() => ({
    enabled: false,
    running: false,
    pid: null,
    startedAt: null,
    lastEventAt: null,
    lastError: "",
  })),
  checkListenSupport: vi.fn(async () => true),
});

const createFakeInstaller = ({ installing = false, error = "" } = {}) => ({
  ensureComposioCliInstalled: vi.fn(() => Promise.resolve({ installed: true })),
  isComposioInstalling: vi.fn(() => installing),
  getComposioInstallError: vi.fn(() => error),
});

const createFakeLoginService = ({ pending = false, error = "" } = {}) => ({
  start: vi.fn(async () => ({
    loginUrl: "https://dashboard.composio.dev/?cliKey=fake",
    startedAt: 1,
  })),
  stop: vi.fn(),
  isPending: vi.fn(() => pending),
  getError: vi.fn(() => error),
});

const createApp = ({
  composioCmd,
  files = new Map(),
  listenService = createFakeListenService(),
  installer = createFakeInstaller(),
  loginService = createFakeLoginService(),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerComposioRoutes({
    listenService,
    installer,
    loginService,
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

  describe("automatic CLI install", () => {
    const kMissingCliCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "" }));

    it("refresh starts a background install when provider is composio and CLI missing", async () => {
      process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
      const installer = createFakeInstaller();
      const app = createApp({ composioCmd: kMissingCliCmd, installer });

      const response = await request(app).post("/api/composio/refresh");

      expect(installer.ensureComposioCliInstalled).toHaveBeenCalled();
      expect(response.body.cliInstalled).toBe(false);
    });

    it("refresh does not install when the provider is gog", async () => {
      const installer = createFakeInstaller();
      const app = createApp({ composioCmd: kMissingCliCmd, installer });

      await request(app).post("/api/composio/refresh");

      expect(installer.ensureComposioCliInstalled).not.toHaveBeenCalled();
    });

    it("refresh does not double-start while an install is running", async () => {
      process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
      const installer = createFakeInstaller({ installing: true });
      const app = createApp({ composioCmd: kMissingCliCmd, installer });

      const response = await request(app).post("/api/composio/refresh");

      expect(installer.ensureComposioCliInstalled).not.toHaveBeenCalled();
      expect(response.body.cliInstalling).toBe(true);
    });

    it("status surfaces installing and error state", async () => {
      const installer = createFakeInstaller({ installing: true, error: "boom" });
      const app = createApp({ installer });

      const response = await request(app).get("/api/composio/status");

      expect(response.body.cliInstalling).toBe(true);
      expect(response.body.installError).toBe("boom");
    });
  });

  describe("sign-in flow", () => {
    it("login/start returns the login URL from the service", async () => {
      const loginService = createFakeLoginService();
      const app = createApp({ loginService });

      const response = await request(app).post("/api/composio/login/start");

      expect(response.body).toEqual({
        ok: true,
        loginUrl: "https://dashboard.composio.dev/?cliKey=fake",
      });
      expect(loginService.start).toHaveBeenCalled();
    });

    it("login/start surfaces service errors", async () => {
      const loginService = createFakeLoginService();
      loginService.start = vi.fn(async () => {
        throw new Error("Composio did not return a login URL");
      });
      const app = createApp({ loginService });

      const response = await request(app).post("/api/composio/login/start");

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("did not return a login URL");
    });

    it("status surfaces login pending and error state", async () => {
      const loginService = createFakeLoginService({ pending: true, error: "expired" });
      const app = createApp({ loginService });

      const response = await request(app).get("/api/composio/status");

      expect(response.body.loginPending).toBe(true);
      expect(response.body.loginError).toBe("expired");
    });
  });

  describe("gmail watch endpoints", () => {
    it("enable delegates to the listen service and returns status", async () => {
      const listenService = createFakeListenService();
      const app = createApp({ listenService });

      const response = await request(app).post("/api/composio/gmail-watch/enable");

      expect(response.body.ok).toBe(true);
      expect(listenService.enable).toHaveBeenCalled();
      expect(response.body.gmailWatch).toBeDefined();
    });

    it("enable surfaces service errors", async () => {
      const listenService = createFakeListenService();
      listenService.enable = vi.fn(async () => {
        throw new Error(
          "The installed Composio CLI does not support trigger subscriptions",
        );
      });
      const app = createApp({ listenService });

      const response = await request(app).post("/api/composio/gmail-watch/enable");

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("does not support trigger");
    });

    it("disable delegates to the listen service", async () => {
      const listenService = createFakeListenService();
      const app = createApp({ listenService });

      const response = await request(app).post("/api/composio/gmail-watch/disable");

      expect(response.body.ok).toBe(true);
      expect(listenService.disable).toHaveBeenCalled();
    });

    it("status includes gmailWatch from the listen service", async () => {
      const listenService = createFakeListenService();
      listenService.getStatus = vi.fn(() => ({
        enabled: true,
        running: true,
        pid: 4242,
        lastEventAt: 123,
        lastError: "",
      }));
      const app = createApp({ listenService });

      const response = await request(app).get("/api/composio/status");

      expect(response.body.gmailWatch).toMatchObject({
        enabled: true,
        running: true,
        pid: 4242,
      });
    });
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

    it("parses the JSON output shape and passes --alias for additional accounts", async () => {
      // Real output captured from `composio link gmail --alias probe-second
      // --no-browser --no-wait` on CLI 0.2.32
      const composioCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify(
          {
            status: "pending",
            message: "Complete authorization by opening the URL",
            connected_account_id: "ca_QAzvmYOWxn_T",
            redirect_url: "https://connect.composio.dev/link/lk_-aHM4PDdeXdC",
            toolkit: "gmail",
          },
          null,
          2,
        ),
        stderr: "",
      }));
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail", alias: "work-2" });

      expect(composioCmd).toHaveBeenCalledWith(
        'link "gmail" --alias "work-2" --no-browser --no-wait',
        { quiet: true, timeoutMs: 60000 },
      );
      expect(response.body).toEqual({
        ok: true,
        toolkit: "gmail",
        alias: "work-2",
        redirectUrl: "https://connect.composio.dev/link/lk_-aHM4PDdeXdC",
      });
    });

    it("rejects invalid aliases without shelling out", async () => {
      const composioCmd = vi.fn();
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail", alias: "bad alias!" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("Invalid account alias");
      expect(composioCmd).not.toHaveBeenCalled();
    });

    it("explains the already-linked case when the CLI silently returns nothing", async () => {
      // Real behavior: linking a toolkit that already has an ACTIVE account
      // without --alias prints nothing to a non-TTY pipe and exits 0
      const composioCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const app = createApp({ composioCmd });

      const response = await request(app)
        .post("/api/composio/link")
        .send({ toolkit: "gmail" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("already has a linked account");
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
        .send({ toolkit: "gmail", alias: "work-2" });

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain("No authorization URL");
    });
  });
});
