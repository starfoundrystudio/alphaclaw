const fs = require("fs");
const path = require("path");
const {
  resolveSetupUiUrl,
  syncBootstrapPromptFiles,
} = require("../../lib/server/onboarding/workspace");

const createPromptSyncFs = ({ googleProvider = "", accounts = [] } = {}) => {
  const written = new Map();
  const stateJson = JSON.stringify({
    version: 2,
    googleProvider,
    accounts,
    gmailPush: { token: "", topics: {} },
  });
  const mockFs = {
    readFileSync: (p, ...rest) => {
      const target = String(p || "");
      if (target.includes(path.join("setup", "core-prompts"))) {
        return fs.readFileSync(p, ...rest);
      }
      if (target.endsWith(path.join("gogcli", "state.json"))) return stateJson;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    existsSync: (p) => String(p || "").endsWith(path.join("gogcli", "state.json")),
    writeFileSync: (p, data) => written.set(String(p), String(data)),
    mkdirSync: () => {},
    copyFileSync: () => {},
  };
  return { mockFs, written };
};

const getWrittenToolsContent = (written) => {
  const entry = [...written.entries()].find(([p]) => p.endsWith("TOOLS.md"));
  return entry ? entry[1] : "";
};

describe("server/onboarding/workspace", () => {
  it("leads the injected AGENTS.md with the mandatory BOOTSTRAP.md first-run gate", () => {
    // The CLI-backend agent runtimes (claude-cli/codex) never receive
    // OpenClaw's system-prompt "Bootstrap Pending" section, so this injected
    // context file is the only hard bootstrap directive those runs see.
    // TeamYou activation depends on the ritual completing, so keep the gate
    // first and keep its blocking language intact.
    const agentsPrompt = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "setup", "core-prompts", "AGENTS.md"),
      "utf8",
    );
    expect(
      agentsPrompt.startsWith("### 🚨 First-Run Gate: BOOTSTRAP.md"),
    ).toBe(true);
    expect(agentsPrompt).toContain("mandatory first action");
    expect(agentsPrompt).toContain(
      "You MUST NOT send a generic greeting or reply normally first",
    );
    expect(agentsPrompt).toContain("**delete BOOTSTRAP.md**");
  });

  const kOriginalRailwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;

  afterEach(() => {
    if (typeof kOriginalRailwayPublicDomain === "undefined") {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      return;
    }
    process.env.RAILWAY_PUBLIC_DOMAIN = kOriginalRailwayPublicDomain;
  });

  it("falls back to Railway public domain when no explicit base URL is provided", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "alphaclaw-production.up.railway.app";

    expect(resolveSetupUiUrl("")).toBe(
      "https://alphaclaw-production.up.railway.app",
    );
  });

  describe("provider-aware TOOLS.md rendering", () => {
    const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;

    beforeEach(() => {
      delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    });

    afterEach(() => {
      if (typeof kOriginalProviderEnv === "undefined") {
        delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
        return;
      }
      process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
    });

    const kAccounts = [
      {
        email: "chrys@example.com",
        client: "default",
        authenticated: true,
        services: ["gmail:read"],
      },
    ];

    it("renders the gog Google Workspace section and account list by default", () => {
      const { mockFs, written } = createPromptSyncFs({ accounts: kAccounts });

      syncBootstrapPromptFiles({
        fs: mockFs,
        workspaceDir: "/tmp/test-workspace",
        baseUrl: "https://setup.example.com",
      });

      const tools = getWrittenToolsContent(written);
      expect(tools).toContain("### Google Workspace");
      expect(tools).toContain("covered by the gog-cli skill");
      expect(tools).toContain("## Available Google Accounts");
      expect(tools).toContain("for gog commands");
      expect(tools).not.toContain("{{GOOGLE_WORKSPACE_SECTION}}");
      expect(tools).not.toContain("{{SETUP_UI_URL}}");
      expect(tools).toContain("https://setup.example.com#general");
    });

    it("renders Composio guidance and suppresses gog content when provider is composio", () => {
      const { mockFs, written } = createPromptSyncFs({
        googleProvider: "composio",
        accounts: kAccounts,
      });

      syncBootstrapPromptFiles({
        fs: mockFs,
        workspaceDir: "/tmp/test-workspace",
        baseUrl: "https://setup.example.com",
      });

      const tools = getWrittenToolsContent(written);
      expect(tools).toContain("### Google Workspace");
      expect(tools).toContain("Composio CLI");
      expect(tools).toContain("composio execute");
      expect(tools).toContain("composio connections list");
      expect(tools).toContain("Do not use the `gog` CLI");
      expect(tools).not.toContain("gog-cli skill");
      expect(tools).not.toContain("## Available Google Accounts");
    });

    it("renders a not-configured section when provider is none", () => {
      const { mockFs, written } = createPromptSyncFs({
        googleProvider: "none",
        accounts: kAccounts,
      });

      syncBootstrapPromptFiles({
        fs: mockFs,
        workspaceDir: "/tmp/test-workspace",
        baseUrl: "https://setup.example.com",
      });

      const tools = getWrittenToolsContent(written);
      expect(tools).toContain(
        "No Google Workspace integration is configured",
      );
      expect(tools).not.toContain("## Available Google Accounts");
    });

    it("lets the env override take precedence over saved state", () => {
      process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
      const { mockFs, written } = createPromptSyncFs({
        googleProvider: "gog",
        accounts: kAccounts,
      });

      syncBootstrapPromptFiles({
        fs: mockFs,
        workspaceDir: "/tmp/test-workspace",
        baseUrl: "https://setup.example.com",
      });

      const tools = getWrittenToolsContent(written);
      expect(tools).toContain("Composio CLI");
      expect(tools).not.toContain("## Available Google Accounts");
    });
  });
});
