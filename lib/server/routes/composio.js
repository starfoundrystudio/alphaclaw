const path = require("path");
const {
  composioStatePath,
  readComposioState,
  refreshComposioState,
  listGoogleWorkspaceAccounts,
  kGoogleWorkspaceToolkits,
} = require("../composio-state");
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
