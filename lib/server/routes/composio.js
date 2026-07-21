const path = require("path");
const {
  composioStatePath,
  readComposioState,
  refreshComposioState,
  listGoogleWorkspaceAccounts,
  kGoogleWorkspaceToolkits,
} = require("../composio-state");
const { quoteShellArg } = require("../utils/shell");

const kToolkitSlugPattern = /^[a-z0-9_-]{1,64}$/i;

const stripAnsi = (text = "") =>
  String(text || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

const extractAuthUrl = (text = "") => {
  const cleaned = stripAnsi(text);
  const match = cleaned.match(/https:\/\/[^\s"'<>\])]+/);
  return match ? match[0] : "";
};
const { readGoogleState, resolveGoogleProvider } = require("../google-state");
const { installComposioSkill } = require("../composio-skill");
const { syncBootstrapPromptFiles } = require("../onboarding/workspace");

const registerComposioRoutes = ({
  app,
  fs,
  constants,
  composioCmd,
  getSetupBaseUrl,
}) => {
  const statePath = composioStatePath(constants.OPENCLAW_DIR);

  const resolveProvider = () =>
    resolveGoogleProvider({
      state: readGoogleState({
        fs,
        statePath: path.join(constants.OPENCLAW_DIR, "gogcli", "state.json"),
      }),
    });

  const buildStatusPayload = (state) => {
    const resolved = resolveProvider();
    return {
      ok: true,
      provider: resolved.provider,
      providerSource: resolved.source,
      cliInstalled: state.cliInstalled,
      loggedIn: state.loggedIn,
      account: state.account || { email: "", orgName: "" },
      apiKeyConfigured: Boolean(
        String(process.env.COMPOSIO_API_KEY || "").trim(),
      ),
      accounts: state.accounts,
      googleAccounts: listGoogleWorkspaceAccounts(state),
      googleToolkits: kGoogleWorkspaceToolkits,
      refreshedAt: state.refreshedAt,
      lastError: state.lastError,
    };
  };

  app.get("/api/composio/status", (req, res) => {
    res.json(buildStatusPayload(readComposioState({ fs, statePath })));
  });

  app.post("/api/composio/link", async (req, res) => {
    const toolkit = String(req.body?.toolkit || "").trim().toLowerCase();
    if (!kToolkitSlugPattern.test(toolkit)) {
      return res.json({ ok: false, error: "Invalid toolkit slug" });
    }
    try {
      // --no-browser prints the authorization URL instead of opening a
      // browser on the server; --no-wait returns immediately so the OAuth
      // completion is picked up later via refresh polling.
      const result = await composioCmd(
        `link ${quoteShellArg(toolkit)} --no-browser --no-wait`,
        { quiet: true, timeoutMs: 60000 },
      );
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const redirectUrl = extractAuthUrl(combinedOutput);
      if (!redirectUrl) {
        const detail = stripAnsi(combinedOutput).trim().slice(0, 300);
        return res.json({
          ok: false,
          error:
            detail ||
            "No authorization URL returned. Is the Composio CLI logged in?",
        });
      }
      res.json({ ok: true, toolkit, redirectUrl });
    } catch (err) {
      console.error("[alphaclaw] Composio link error:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/composio/refresh", async (req, res) => {
    try {
      const state = await refreshComposioState({ fs, statePath, composioCmd });
      try {
        installComposioSkill({ fs, openclawDir: constants.OPENCLAW_DIR });
      } catch {}
      try {
        syncBootstrapPromptFiles({
          fs,
          workspaceDir: constants.WORKSPACE_DIR,
          baseUrl: getSetupBaseUrl(req),
        });
      } catch {}
      res.json(buildStatusPayload(state));
    } catch (err) {
      console.error("[alphaclaw] Composio refresh error:", err);
      res.json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerComposioRoutes };
