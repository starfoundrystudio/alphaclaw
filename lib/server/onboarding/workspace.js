const path = require("path");
const { execSync } = require("child_process");
const {
  kSetupDir,
  OPENCLAW_DIR,
  ENV_FILE_PATH,
} = require("../constants");
const { renderTopicRegistryMarkdown } = require("../topic-registry");
const { readGoogleState, resolveGoogleProvider } = require("../google-state");

const resolveSetupUiUrl = (baseUrl) => {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (normalizedBaseUrl) return normalizedBaseUrl;

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  const railwayStaticUrl = String(process.env.RAILWAY_STATIC_URL || "").trim().replace(
    /\/+$/,
    "",
  );
  if (railwayStaticUrl) return railwayStaticUrl;

  return "http://localhost:3000";
};

// Single assembly point for TOOLS.md: template + topic registry.
// Idempotent — always rebuilds from source so deploys never clobber topic data.
const isTelegramWorkspaceEnabled = (fs) => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const telegramConfig = cfg.channels?.telegram || {};
    const topLevelGroupCount = Object.keys(telegramConfig.groups || {}).length;
    if (topLevelGroupCount > 0) return true;
    const accounts =
      telegramConfig.accounts && typeof telegramConfig.accounts === "object"
        ? telegramConfig.accounts
        : {};
    for (const accountConfig of Object.values(accounts)) {
      if (Object.keys(accountConfig?.groups || {}).length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
};

const readGoogleStateFromDisk = (fs) =>
  readGoogleState({ fs, statePath: `${OPENCLAW_DIR}/gogcli/state.json` });

const kGoogleWorkspaceSections = {
  gog: [
    "### Google Workspace",
    "",
    "Google Workspace is connected via the **General** tab (`{{SETUP_UI_URL}}#general`). The user provides OAuth client credentials from Google Cloud Console, then authorizes access to the services they need (Gmail, Calendar, Drive, Sheets, Docs, Tasks, Contacts, Meet). Connected accounts and `gog` CLI usage are covered by the gog-cli skill.",
  ].join("\n"),
  composio: [
    "### Google Workspace",
    "",
    "Google Workspace (Gmail, Calendar, Drive, Sheets, Docs, and more) is integrated through the **Composio CLI** (`composio`), which manages OAuth and token refresh — there is no Google Cloud project or `gog` CLI in this deployment. Run tools with `composio execute <TOOL_SLUG> -d '{ ... }'`, inspect inputs with `composio execute <TOOL_SLUG> --get-schema`, find slugs with `composio search \"<task>\"`, and check linked accounts with `composio connections list`. Accounts are linked from the **General** tab (`{{SETUP_UI_URL}}#general`) or via `composio link <toolkit>`. Linked accounts and detailed usage are covered by the composio skill. Do not use the `gog` CLI and do not ask the user for Google Cloud OAuth credentials.",
  ].join("\n"),
  none: [
    "### Google Workspace",
    "",
    "No Google Workspace integration is configured in this deployment. Do not assume the `gog` CLI or any Google Workspace tooling is available.",
  ].join("\n"),
};

const renderGoogleWorkspaceSection = (provider) =>
  kGoogleWorkspaceSections[provider] || kGoogleWorkspaceSections.none;

const renderGoogleAccountsMarkdown = (fs) => {
  try {
    const state = readGoogleStateFromDisk(fs);
    // The account list instructs agents to use gog commands; suppress it
    // entirely when gog is not the active Google provider.
    if (resolveGoogleProvider({ state }).provider !== "gog") return "";
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    let section = "\n\n## Available Google Accounts\n\n";
    if (!accounts.length) {
      section += "No Google accounts are currently configured.\n";
      return section;
    }
    section +=
      "Configured in AlphaClaw (use `--client <client> --account <email>` for gog commands):\n\n";
    section += accounts
      .map((account) => {
        const email = String(account.email || "").trim() || "(unknown email)";
        const client = String(account.client || "default").trim() || "default";
        const personal = account.personal ? "personal" : "company";
        const auth = account.authenticated ? "authenticated" : "awaiting sign-in";
        const services = Array.isArray(account.services) ? account.services.join(", ") : "";
        const metaParts = [
          `type: ${personal}`,
          `client: ${client}`,
          `status: ${auth}`,
          services ? `services: ${services}` : null,
        ].filter(Boolean);
        return `- ${email} (${metaParts.join("; ")})`;
      })
      .join("\n");
    section += "\n";
    return section;
  } catch {
    return "";
  }
};

const resolveAllAgentWorkspaces = (fs) => {
  try {
    const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    return list
      .map((entry) => {
        const agentId = String(entry.id || "").trim();
        const workspace = String(entry.workspace || "").trim();
        if (!agentId || !workspace) return null;
        return {
          agentId,
          workspace,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const syncBootstrapPromptFiles = ({ fs, workspaceDir, baseUrl }) => {
  try {
    const setupUiUrl = resolveSetupUiUrl(baseUrl);

    const toolsTemplate = fs.readFileSync(
      path.join(kSetupDir, "core-prompts", "TOOLS.md"),
      "utf8",
    );
    const includeSyncGuidance = isTelegramWorkspaceEnabled(fs);
    const googleProvider = (() => {
      try {
        return resolveGoogleProvider({ state: readGoogleStateFromDisk(fs) }).provider;
      } catch {
        return "gog";
      }
    })();
    const googleWorkspaceSection = renderGoogleWorkspaceSection(googleProvider);
    const googleAccountsSection = renderGoogleAccountsMarkdown(fs);
    const buildToolsContent = ({ agentId = "" } = {}) => {
      let toolsContent = toolsTemplate
        .replace(/\{\{GOOGLE_WORKSPACE_SECTION\}\}/g, () => googleWorkspaceSection)
        .replace(/\{\{SETUP_UI_URL\}\}/g, setupUiUrl);
      const topicSection = renderTopicRegistryMarkdown({
        includeSyncGuidance,
        agentId,
      });
      if (topicSection) {
        toolsContent += topicSection;
      }
      if (googleAccountsSection) {
        toolsContent += googleAccountsSection;
      }
      return toolsContent;
    };

    const agentsSourcePath = path.join(kSetupDir, "core-prompts", "AGENTS.md");

    const writeToWorkspace = (targetDir, toolsContent) => {
      const bootstrapDir = path.join(targetDir, "hooks", "bootstrap");
      fs.mkdirSync(bootstrapDir, { recursive: true });
      fs.copyFileSync(agentsSourcePath, path.join(bootstrapDir, "AGENTS.md"));
      fs.writeFileSync(path.join(bootstrapDir, "TOOLS.md"), toolsContent);
    };

    writeToWorkspace(workspaceDir, buildToolsContent());

    const otherWorkspaces = resolveAllAgentWorkspaces(fs).filter(
      (entry) => path.resolve(entry.workspace) !== path.resolve(workspaceDir),
    );
    for (const entry of otherWorkspaces) {
      try {
        writeToWorkspace(
          entry.workspace,
          buildToolsContent({ agentId: entry.agentId }),
        );
      } catch (e) {
        console.error(
          `[onboard] Bootstrap sync skipped for ${entry.workspace}: ${e.message}`,
        );
      }
    }

    console.log("[onboard] Bootstrap prompt files synced");
  } catch (e) {
    console.error("[onboard] Bootstrap prompt sync error:", e.message);
  }
};

const ensureOpenclawRuntimeArtifacts = ({
  fs,
  openclawDir,
  envFilePath = ENV_FILE_PATH,
}) => {
  try {
    const openclawEnvLink = path.join(openclawDir, ".env");
    if (!fs.existsSync(openclawEnvLink) && fs.existsSync(envFilePath)) {
      fs.symlinkSync(envFilePath, openclawEnvLink);
      console.log(`[alphaclaw] Symlinked ${openclawEnvLink} -> ${envFilePath}`);
    }
  } catch (e) {
    console.log(`[alphaclaw] .env symlink skipped: ${e.message}`);
  }

  const googleProvider = (() => {
    try {
      const state = readGoogleState({
        fs,
        statePath: path.join(openclawDir, "gogcli", "state.json"),
      });
      return resolveGoogleProvider({ state }).provider;
    } catch {
      return "gog";
    }
  })();
  if (googleProvider !== "gog") return;

  const gogConfigFile = path.join(openclawDir, "gogcli", "config.json");
  if (!fs.existsSync(gogConfigFile)) {
    fs.mkdirSync(path.join(openclawDir, "gogcli"), { recursive: true });
    try {
      execSync("gog auth keyring file", { stdio: "ignore" });
      console.log("[alphaclaw] gog keyring configured (file backend)");
    } catch {}
  }
};

module.exports = {
  ensureOpenclawRuntimeArtifacts,
  resolveSetupUiUrl,
  syncBootstrapPromptFiles,
};
