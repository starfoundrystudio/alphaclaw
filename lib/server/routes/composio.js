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
const kLinkAliasPattern = /^[a-z0-9_-]{1,64}$/i;

const stripAnsi = (text = "") =>
  String(text || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

const extractAuthUrl = (text = "") => {
  const cleaned = stripAnsi(text);
  const match = cleaned.match(/https:\/\/[^\s"'<>\])]+/);
  return match ? match[0] : "";
};
const { readGoogleState, resolveGoogleProvider } = require("../google-state");
const { installComposioSkill } = require("../composio-skill");
const { createComposioListenService } = require("../composio-listen");
const { createComposioLoginService } = require("../composio-login");
const { syncBootstrapPromptFiles } = require("../onboarding/workspace");
const composioInstallModule = require("../composio-install");

const registerComposioRoutes = ({
  app,
  fs,
  constants,
  composioCmd,
  getSetupBaseUrl,
  ensureHookWiring = () => {},
  listenService = null,
  loginService = null,
  installer = composioInstallModule,
}) => {
  const statePath = composioStatePath(constants.OPENCLAW_DIR);
  const composioListenService =
    listenService ||
    createComposioListenService({
      fs,
      constants,
      composioCmd,
      ensureHookWiring,
    });
  const composioLoginService =
    loginService ||
    createComposioLoginService({
      composioCmd,
      onLoginComplete: () => refreshStateAndArtifacts(null),
    });

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
      cliInstalling: installer.isComposioInstalling(),
      installError: installer.getComposioInstallError(),
      loginPending: composioLoginService.isPending(),
      loginError: composioLoginService.getError(),
      gmailWatch: composioListenService.getStatus(),
    };
  };

  const refreshStateAndArtifacts = async (req) => {
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
    return state;
  };

  // When the provider is composio and the CLI is absent, install it from the
  // running server — customers cannot be asked to restart the AlphaClaw
  // process (the dashboard Restart button only restarts the gateway).
  const maybeStartCliInstall = (req, state) => {
    if (state.cliInstalled) return false;
    if (installer.isComposioInstalling()) return true;
    if (resolveProvider().provider !== "composio") return false;
    installer.ensureComposioCliInstalled({
      fs,
      onComplete: () => refreshStateAndArtifacts(req),
    });
    return true;
  };

  app.get("/api/composio/status", (req, res) => {
    res.json(buildStatusPayload(readComposioState({ fs, statePath })));
  });

  app.post("/api/composio/link", async (req, res) => {
    const toolkit = String(req.body?.toolkit || "").trim().toLowerCase();
    if (!kToolkitSlugPattern.test(toolkit)) {
      return res.json({ ok: false, error: "Invalid toolkit slug" });
    }
    const alias = String(req.body?.alias || "").trim();
    if (alias && !kLinkAliasPattern.test(alias)) {
      return res.json({ ok: false, error: "Invalid account alias" });
    }
    try {
      // --no-browser prints the authorization URL instead of opening a
      // browser on the server; --no-wait returns immediately so the OAuth
      // completion is picked up later via refresh polling. Linking an
      // additional account for an already-connected toolkit requires --alias;
      // without it the CLI silently produces no URL in a non-TTY pipe.
      const aliasArg = alias ? ` --alias ${quoteShellArg(alias)}` : "";
      const result = await composioCmd(
        `link ${quoteShellArg(toolkit)}${aliasArg} --no-browser --no-wait`,
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
            (alias
              ? "No authorization URL returned. Is the Composio CLI signed in?"
              : "No authorization URL returned — this usually means the toolkit already has a linked account. Retry with an account alias to link another."),
        });
      }
      res.json({ ok: true, toolkit, redirectUrl, ...(alias ? { alias } : {}) });
    } catch (err) {
      console.error("[alphaclaw] Composio link error:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/composio/login/start", async (req, res) => {
    try {
      const { loginUrl } = await composioLoginService.start();
      res.json({ ok: true, loginUrl });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/composio/gmail-watch/enable", async (req, res) => {
    try {
      const result = await composioListenService.enable();
      res.json({ ...result, gmailWatch: composioListenService.getStatus() });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/composio/gmail-watch/disable", async (req, res) => {
    try {
      await composioListenService.disable();
      res.json({ ok: true, gmailWatch: composioListenService.getStatus() });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/composio/refresh", async (req, res) => {
    try {
      const state = await refreshStateAndArtifacts(req);
      maybeStartCliInstall(req, state);
      res.json(buildStatusPayload(state));
    } catch (err) {
      console.error("[alphaclaw] Composio refresh error:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  // The returned service drives boot start and shutdown; fold the login
  // poller's cleanup into the same stop hook.
  return {
    ...composioListenService,
    stop: async () => {
      composioLoginService.stop();
      await composioListenService.stop();
    },
  };
};

module.exports = { registerComposioRoutes };
