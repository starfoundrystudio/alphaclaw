const crypto = require("crypto");

const {
  kDefaultGoogleClient,
  kDefaultGoogleScopes,
  createGoogleAccountId,
  readGoogleState,
  writeGoogleState,
  listGoogleAccounts,
  getGoogleAccountById,
  getGoogleAccountByEmailAndClient,
  upsertGoogleAccount,
  removeGoogleAccount,
  kGoogleProviders,
  normalizeGoogleProviderValue,
  resolveGoogleProvider,
  setGoogleProvider,
} = require("../google-state");
const { syncBootstrapPromptFiles } = require("../onboarding/workspace");
const { installGogCliSkill } = require("../gog-skill");
const { installComposioSkill } = require("../composio-skill");
const { parseJsonSafe } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");

const uniqueServiceLabels = (scopes) =>
  Array.from(
    new Set(
      (scopes || [])
        .map((scope) => String(scope || "").split(":")[0])
        .filter(Boolean),
    ),
  );

const sendGoogleOauthResultPage = (
  res,
  { ok = false, accountId = "", email = "", message = "" } = {},
) => {
  const payload = JSON.stringify(
    ok
      ? { google: "success", accountId: String(accountId), email: String(email) }
      : { google: "error", message: String(message) },
  ).replace(/[<>&]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const bodyMessage = ok
    ? "Google connected!"
    : `Google OAuth failed (${String(message || "unknown_error")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}).`;
  return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage(${payload}, '*');
      window.close();
    </script><p>${bodyMessage} You can close this window.</p></body></html>`);
};

const registerGoogleRoutes = ({
  app,
  fs,
  isGatewayRunning,
  gogCmd,
  getSetupBaseUrl,
  getPublicBaseUrl,
  readGoogleCredentials,
  getApiEnableUrl,
  gogBrokerService,
  constants,
}) => {
  const googleOauthStates = new Map();
  const {
    GOG_CONFIG_DIR,
    GOG_STATE_PATH,
    API_TEST_COMMANDS,
    BASE_SCOPES,
    SCOPE_MAP,
    REVERSE_SCOPE_MAP,
    kMaxGoogleAccounts,
    gogClientCredentialsPath,
  } = constants;

  const readState = () => readGoogleState({ fs, statePath: GOG_STATE_PATH });
  const saveState = (state) => writeGoogleState({ fs, statePath: GOG_STATE_PATH, state });
  const syncBootstrapTools = (req) => {
    try {
      syncBootstrapPromptFiles({
        fs,
        workspaceDir: constants.WORKSPACE_DIR,
        baseUrl: getSetupBaseUrl(req),
      });
    } catch {}
    try {
      installGogCliSkill({ fs, openclawDir: constants.OPENCLAW_DIR });
    } catch {}
    try {
      installComposioSkill({ fs, openclawDir: constants.OPENCLAW_DIR });
    } catch {}
  };

  const listAuthenticatedAccounts = async (state) => {
    const configuredClients = new Set([kDefaultGoogleClient]);
    listGoogleAccounts(state)
      .filter((account) => !account.brokerConsumer)
      .forEach((account) => {
      const client = String(account.client || kDefaultGoogleClient).trim() || kDefaultGoogleClient;
      configuredClients.add(client);
    });
    if (listGoogleAccounts(state).every((account) => account.brokerConsumer)) {
      return [];
    }
    const combined = [];
    for (const client of configuredClients) {
      const command =
        client === kDefaultGoogleClient
          ? "auth list --json --check"
          : `--client ${quoteShellArg(client)} auth list --json --check`;
      const result = await gogCmd(command, {
        quiet: true,
        authBypass: true,
      });
      if (!result.ok) continue;
      const parsed = parseJsonSafe(result.stdout, { accounts: [] });
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      accounts.forEach((entry) => {
        combined.push({
          ...entry,
          client: String(entry.client || client || kDefaultGoogleClient).trim() || kDefaultGoogleClient,
        });
      });
    }
    return combined;
  };

  const accountIsAuthenticated = ({ account, authenticatedAccounts }) =>
    authenticatedAccounts.some(
      (entry) =>
        String(entry.email || "").trim().toLowerCase() === String(account.email || "").trim().toLowerCase() &&
        String(entry.client || kDefaultGoogleClient).trim() === String(account.client || kDefaultGoogleClient).trim() &&
        (entry.valid !== false),
    );

  const getSelectedAccount = ({ state, accountId, fallbackToFirst = true }) => {
    if (accountId) {
      return getGoogleAccountById(state, accountId);
    }
    return fallbackToFirst ? listGoogleAccounts(state)[0] || null : null;
  };

  const clearStoredGoogleAuthForEmail = async ({
    email,
    preferredClient = kDefaultGoogleClient,
    extraClients = [],
  }) => {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) return;
    const clientCandidates = new Set([
      kDefaultGoogleClient,
      preferredClient,
      ...extraClients,
    ]);
    for (const clientName of clientCandidates) {
      const safeClientName =
        String(clientName || "").trim() || kDefaultGoogleClient;
      const clientArg =
        safeClientName === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(safeClientName)} `;
      await gogCmd(
        `${clientArg}auth remove ${quoteShellArg(normalizedEmail)} --force`,
        { quiet: true, authBypass: true },
      );
    }
  };

  const stageClientCredentials = ({ client, clientId, clientSecret, req }) => {
    const credentialsPath = gogClientCredentialsPath(client);
    const stagedPath = `${credentialsPath}.pending-${crypto
      .randomBytes(8)
      .toString("hex")}`;
    fs.mkdirSync(GOG_CONFIG_DIR, { recursive: true });
    const credentials = {
      web: {
        client_id: clientId,
        client_secret: clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: [`${getPublicBaseUrl(req)}/auth/google/callback`],
      },
    };
    fs.writeFileSync(stagedPath, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    fs.chmodSync?.(stagedPath, 0o600);
    return { credentialsPath, stagedPath };
  };

  app.get("/api/google/provider", (req, res) => {
    const state = readState();
    const resolved = resolveGoogleProvider({ state });
    res.json({
      ok: true,
      provider: resolved.provider,
      source: resolved.source,
      providers: kGoogleProviders,
    });
  });

  app.post("/api/google/provider", (req, res) => {
    const provider = normalizeGoogleProviderValue(req.body?.provider);
    if (!provider) {
      return res.json({
        ok: false,
        error: `Invalid provider. Expected one of: ${kGoogleProviders.join(", ")}`,
      });
    }
    try {
      const { state: nextState } = setGoogleProvider({
        state: readState(),
        provider,
      });
      saveState(nextState);
      // Regenerate the gog-cli skill and workspace prompt files so agents see
      // the provider change immediately.
      syncBootstrapTools(req);
      const resolved = resolveGoogleProvider({ state: nextState });
      res.json({ ok: true, provider: resolved.provider, source: resolved.source });
    } catch (err) {
      console.error("[alphaclaw] Failed to save Google provider:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.get("/api/google/accounts", async (req, res) => {
    const state = readState();
    const authenticatedAccounts = await listAuthenticatedAccounts(state);
    const accounts = listGoogleAccounts(state).map((account) => {
      const activeScopes = account.services || [];
      const services = uniqueServiceLabels(activeScopes).join(", ");
      const hasCredentials =
        Boolean(account.brokerConsumer) ||
        fs.existsSync(gogClientCredentialsPath(account.client));
      return {
        ...account,
        services,
        activeScopes,
        hasCredentials,
        authenticated:
          hasCredentials &&
          (Boolean(account.authenticated) || accountIsAuthenticated({ account, authenticatedAccounts })),
      };
    });
    res.json({
      ok: true,
      // These booleans mean a reusable local client credential exists for
      // adding another account. A brokered account remains connected without
      // keeping that client secret on the workload.
      hasCompanyCredentials: fs.existsSync(
        gogClientCredentialsPath(kDefaultGoogleClient),
      ),
      hasPersonalCredentials: fs.existsSync(
        gogClientCredentialsPath("personal"),
      ),
      accounts,
    });
  });

  app.get("/api/google/status", async (req, res) => {
    if (!(await isGatewayRunning())) {
      return res.json({
        hasCredentials: false,
        authenticated: false,
        email: "",
        services: "",
        activeScopes: [],
      });
    }
    const state = readState();
    const selected = getSelectedAccount({
      state,
      accountId: String(req.query.accountId || ""),
      fallbackToFirst: true,
    });
    if (!selected) {
      return res.json({
        hasCredentials: false,
        authenticated: false,
        email: "",
        services: "",
        activeScopes: [],
      });
    }
    const authenticatedAccounts = await listAuthenticatedAccounts(state);
    const activeScopes = selected.services || [];
    const services = uniqueServiceLabels(activeScopes).join(", ");
    const hasCredentials =
      Boolean(selected.brokerConsumer) ||
      fs.existsSync(gogClientCredentialsPath(selected.client));
    res.json({
      accountId: selected.id,
      client: selected.client,
      personal: selected.personal,
      hasCredentials,
      authenticated:
        hasCredentials &&
        (Boolean(selected.authenticated) ||
          accountIsAuthenticated({ account: selected, authenticatedAccounts })),
      email: selected.email,
      services,
      activeScopes,
    });
  });

  app.get("/api/google/credentials", (req, res) => {
    const state = readState();
    const accountId = String(req.query.accountId || "").trim();
    const requestedClient = String(req.query.client || "").trim();
    const account = accountId ? getGoogleAccountById(state, accountId) : null;
    const client =
      String(account?.client || requestedClient || kDefaultGoogleClient).trim()
      || kDefaultGoogleClient;
    const credentials = readGoogleCredentials(client);
    const brokered = Boolean(account?.brokerConsumer);
    const hasCredentials =
      brokered || Boolean(credentials.clientId && credentials.clientSecret);
    res.json({
      ok: true,
      client,
      hasCredentials,
      clientId: brokered ? "" : credentials.clientId || "",
      clientSecret: brokered ? "" : credentials.clientSecret || "",
    });
  });

  app.post("/api/google/credentials", async (req, res) => {
    const body = req.body || {};
    const clientId = String(body.clientId || "").trim();
    const clientSecret = String(body.clientSecret || "").trim();
    const email = String(body.email || "").trim();
    const accountId = String(body.accountId || "").trim();
    const personal = Boolean(body.personal);
    const client = String(body.client || (personal ? "personal" : kDefaultGoogleClient)).trim()
      || kDefaultGoogleClient;
    if (!clientId || !clientSecret || !email) {
      return res.json({ ok: false, error: "Missing fields" });
    }

    let stagedCredentialsPath = "";
    try {
      const state = readState();
      const existing = accountId ? getGoogleAccountById(state, accountId) : null;
      const legacyClientsForEmail = listGoogleAccounts(state)
        .filter(
          (entry) =>
            String(entry.email || "").trim().toLowerCase() ===
            email.toLowerCase(),
        )
        .map((entry) => String(entry.client || kDefaultGoogleClient).trim());
      await clearStoredGoogleAuthForEmail({
        email,
        preferredClient: client,
        extraClients: [
          ...legacyClientsForEmail,
          String(existing?.client || "").trim(),
        ],
      });
      const { credentialsPath, stagedPath } = stageClientCredentials({
        client,
        clientId,
        clientSecret,
        req,
      });
      stagedCredentialsPath = stagedPath;
      const command = client === kDefaultGoogleClient
        ? `auth credentials set ${quoteShellArg(stagedPath)} --insecure`
        : `--client ${quoteShellArg(client)} auth credentials set ${quoteShellArg(stagedPath)} --insecure`;
      const result = await gogCmd(command, {
        quiet: true,
        authBypass: true,
      });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to set Google client credentials");
      }
      fs.renameSync(stagedPath, credentialsPath);
      stagedCredentialsPath = "";
      fs.chmodSync?.(credentialsPath, 0o600);

      const { state: nextState, account } = upsertGoogleAccount({
        state,
        maxAccounts: kMaxGoogleAccounts,
        account: {
          id: existing?.id || accountId || createGoogleAccountId(),
          email,
          personal,
          client,
          services: body.services || existing?.services || kDefaultGoogleScopes,
          authenticated: false,
        },
      });
      saveState(nextState);
      syncBootstrapTools(req);

      res.json({ ok: true, accountId: account.id, account });
    } catch (err) {
      if (stagedCredentialsPath) {
        try {
          fs.unlinkSync(stagedCredentialsPath);
        } catch {}
      }
      console.error("[alphaclaw] Failed to save Google credentials:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/google/accounts", (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    const accountId = String(body.accountId || "").trim();
    const personal = Boolean(body.personal);
    const client = String(body.client || (personal ? "personal" : kDefaultGoogleClient)).trim()
      || kDefaultGoogleClient;
    if (!email) {
      return res.json({ ok: false, error: "Missing fields" });
    }
    if (!fs.existsSync(gogClientCredentialsPath(client))) {
      return res.json({
        ok: false,
        error: "Credentials missing for selected client. Save credentials first.",
      });
    }
    try {
      const state = readState();
      const existing = accountId ? getGoogleAccountById(state, accountId) : null;
      const { state: nextState, account } = upsertGoogleAccount({
        state,
        maxAccounts: kMaxGoogleAccounts,
        account: {
          id: existing?.id || accountId || createGoogleAccountId(),
          email,
          personal,
          client,
          services: body.services || existing?.services || kDefaultGoogleScopes,
          authenticated: Boolean(existing?.authenticated),
        },
      });
      saveState(nextState);
      syncBootstrapTools(req);
      res.json({ ok: true, accountId: account.id, account });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get("/api/google/check", async (req, res) => {
    const state = readState();
    const account = getSelectedAccount({
      state,
      accountId: String(req.query.accountId || ""),
      fallbackToFirst: true,
    });
    if (!account) return res.json({ error: "No Google account configured" });

    const enabledServices = uniqueServiceLabels(account.services || []);
    const results = {};
    for (const svc of enabledServices) {
      const cmd = API_TEST_COMMANDS[svc];
      if (!cmd) continue;
      const clientArg =
        account.client === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(account.client)} `;
      const result = await gogCmd(
        `${clientArg}${cmd} --account ${quoteShellArg(account.email)}`,
        { quiet: true },
      );
      const stderr = result.stderr || "";
      if (stderr.includes("has not been used") || stderr.includes("is not enabled")) {
        const projectMatch = stderr.match(/project=(\d+)/);
        results[svc] = {
          status: "not_enabled",
          enableUrl: getApiEnableUrl(svc, projectMatch?.[1]),
        };
      } else if (result.ok || stderr.includes("not found") || stderr.includes("Not Found")) {
        results[svc] = { status: "ok", enableUrl: getApiEnableUrl(svc) };
      } else {
        results[svc] = {
          status: "error",
          message: result.stderr?.slice(0, 200),
          enableUrl: getApiEnableUrl(svc),
        };
      }
    }
    res.json({ accountId: account.id, email: account.email, results });
  });

  app.post("/api/google/disconnect", async (req, res) => {
    const accountId = String(req.body?.accountId || "").trim();
    const state = readState();
    const account = getSelectedAccount({ state, accountId, fallbackToFirst: true });
    if (!account) return res.json({ ok: true });
    try {
      if (account.brokerConsumer && gogBrokerService) {
        const result = await gogBrokerService.disconnect({ account });
        syncBootstrapTools(req);
        return res.json({
          ok: !result.revocationPending,
          localDisconnected: result.localDisconnected,
          revocationPending: result.revocationPending,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      const revokeFile = `/tmp/gog-revoke-${Date.now()}.json`;
      const clientArg =
        account.client === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(account.client)} `;
      const exportResult = await gogCmd(
        `${clientArg}auth tokens export ${quoteShellArg(account.email)} --out ${quoteShellArg(revokeFile)} --overwrite`,
        { quiet: true, authBypass: true },
      );
      if (exportResult.ok && fs.existsSync(revokeFile)) {
        try {
          const tokenData = parseJsonSafe(fs.readFileSync(revokeFile, "utf8"), {});
          if (tokenData.refresh_token) {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenData.refresh_token}`, {
              method: "POST",
            });
          }
        } catch {}
      }
      try {
        fs.unlinkSync(revokeFile);
      } catch {}
      await gogCmd(
        `${clientArg}auth remove ${quoteShellArg(account.email)} --force`,
        { quiet: true, authBypass: true },
      );
      const { state: nextState } = removeGoogleAccount({
        state,
        accountId: account.id,
      });
      saveState(nextState);
      syncBootstrapTools(req);
      res.json({ ok: true });
    } catch (err) {
      console.error("[alphaclaw] Google disconnect error:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.get("/auth/google/start", (req, res) => {
    const state = readState();
    const requestedAccountId = String(req.query.accountId || "").trim();
    const requestedClient = String(req.query.client || "").trim();
    let account = requestedAccountId
      ? getGoogleAccountById(state, requestedAccountId)
      : null;
    if (!account && req.query.email) {
      account = getGoogleAccountByEmailAndClient(
        state,
        String(req.query.email || "").trim(),
        requestedClient || kDefaultGoogleClient,
      );
    }
    const client = account?.client || requestedClient || kDefaultGoogleClient;
    const email = account?.email || String(req.query.email || "").trim();
    const services = (
      req.query.services ||
      (account?.services || kDefaultGoogleScopes).join(",")
    )
      .split(",")
      .map((scope) => String(scope || "").trim())
      .filter(Boolean);
    try {
      const { clientId } = readGoogleCredentials(client);
      if (!clientId) throw new Error("No client_id found");
      const scopes = [
        ...BASE_SCOPES,
        ...services.map((scope) => SCOPE_MAP[scope]).filter(Boolean),
      ].join(" ");
      const redirectUri = `${getPublicBaseUrl(req)}/auth/google/callback`;
      const encodedState = crypto.randomBytes(32).toString("base64url");
      const statePayload = {
        accountId: account?.id || requestedAccountId || "",
        client,
        email,
        services,
      };
      const now = Date.now();
      for (const [key, entry] of googleOauthStates) {
        if (entry.expiresAt <= now) googleOauthStates.delete(key);
      }
      googleOauthStates.set(encodedState, {
        payload: statePayload,
        expiresAt: now + 10 * 60 * 1000,
      });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", encodedState);
      if (email) authUrl.searchParams.set("login_hint", email);
      res.redirect(authUrl.toString());
    } catch (err) {
      console.error("[alphaclaw] Failed to start Google auth:", err);
      res.redirect(`/setup?google=error&message=${encodeURIComponent(err.message)}`);
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return sendGoogleOauthResultPage(res, {
        ok: false,
        message: String(error || "unknown_error"),
      });
    }
    if (!code) {
      return sendGoogleOauthResultPage(res, {
        ok: false,
        message: "no_code",
      });
    }

    try {
      const stateKey = String(state || "");
      const stateEntry = googleOauthStates.get(stateKey);
      googleOauthStates.delete(stateKey);
      if (!stateEntry || stateEntry.expiresAt <= Date.now()) {
        const stateError = new Error("Google OAuth state is invalid or expired");
        stateError.code = "invalid_oauth_state";
        throw stateError;
      }
      const decodedState = stateEntry.payload;
      const accountId = String(decodedState.accountId || "").trim();
      const requestedClient = String(decodedState.client || "").trim();
      const stateData = readState();
      const existingAccount = accountId
        ? getGoogleAccountById(stateData, accountId)
        : getGoogleAccountByEmailAndClient(
            stateData,
            String(decodedState.email || "").trim(),
            requestedClient || kDefaultGoogleClient,
          );
      const client = existingAccount?.client || requestedClient || kDefaultGoogleClient;
      const { clientId, clientSecret } = readGoogleCredentials(client);
      if (!clientId || !clientSecret) {
        throw new Error(`Google credentials missing for client "${client}"`);
      }
      const redirectUri = `${getPublicBaseUrl(req)}/auth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || tokens.error) {
        throw new Error(`Google token error: ${tokens.error_description || tokens.error || "exchange_failed"}`);
      }

      if (
        !tokens.refresh_token &&
        (gogBrokerService?.isBrokeredMode() || !existingAccount?.authenticated)
      ) {
        throw new Error(
          "No refresh token received. Revoke app access at myaccount.google.com/permissions and retry.",
        );
      }

      const expectedEmail = String(
        existingAccount?.email || decodedState.email || "",
      ).trim();
      if (!tokens.access_token) {
        throw new Error("Google token exchange did not return an access token");
      }
      const infoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      const info = await infoRes.json();
      const email = String(info.email || "").trim();
      if (!infoRes.ok || !email) {
        throw new Error("Google did not return the authorized account identity");
      }
      if (
        expectedEmail &&
        email &&
        expectedEmail.toLowerCase() !== email.toLowerCase()
      ) {
        throw new Error(
          `Google authorized ${email}, but ${expectedEmail} was requested`,
        );
      }

      if (tokens.refresh_token && !gogBrokerService?.isBrokeredMode()) {
        const tokenFile = `/tmp/gog-token-${Date.now()}.json`;
        const tokenData = {
          email,
          client,
          created_at: new Date().toISOString(),
          refresh_token: tokens.refresh_token,
        };
        fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
        const importCmd =
          client === kDefaultGoogleClient
            ? `auth tokens import ${quoteShellArg(tokenFile)}`
            : `--client ${quoteShellArg(client)} auth tokens import ${quoteShellArg(tokenFile)}`;
        const result = await gogCmd(importCmd, {
          quiet: true,
          authBypass: true,
        });
        try {
          fs.unlinkSync(tokenFile);
        } catch {}
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to import Google token");
        }
      }

      const requestedServices = Array.isArray(decodedState.services)
        ? decodedState.services
        : [];
      const grantedServices = tokens.scope
        ? tokens.scope
            .split(" ")
            .map((scope) => REVERSE_SCOPE_MAP[scope])
            .filter(Boolean)
        : requestedServices;
      const accountInput = {
        id: existingAccount?.id || accountId || createGoogleAccountId(),
        email,
        personal: Boolean(existingAccount?.personal),
        client,
        services: grantedServices.length ? grantedServices : requestedServices,
        authenticated: true,
        brokerConsumer: existingAccount?.brokerConsumer || "",
      };
      let account;
      if (gogBrokerService?.isBrokeredMode()) {
        const brokerScopes = String(tokens.scope || "")
          .split(" ")
          .map((scope) => scope.trim())
          .filter(Boolean);
        const adopted = await gogBrokerService.adoptGrant({
          account: accountInput,
          clientId,
          clientSecret,
          refreshToken: tokens.refresh_token,
          scopes: brokerScopes.length
            ? brokerScopes
            : [
                ...BASE_SCOPES,
                ...requestedServices
                  .map((scope) => SCOPE_MAP[scope])
                  .filter(Boolean),
              ],
        });
        account = { ...accountInput, brokerConsumer: adopted.consumer };
      } else {
        const upserted = upsertGoogleAccount({
          state: stateData,
          maxAccounts: kMaxGoogleAccounts,
          account: accountInput,
        });
        saveState(upserted.state);
        account = upserted.account;
      }
      syncBootstrapTools(req);

      return sendGoogleOauthResultPage(res, {
        ok: true,
        accountId: account.id,
        email,
      });
    } catch (err) {
      console.error("[alphaclaw] Google OAuth callback error:", err);
      return sendGoogleOauthResultPage(res, {
        ok: false,
        message: String(err.message || "unknown_error"),
      });
    }
  });
};

module.exports = { registerGoogleRoutes };
