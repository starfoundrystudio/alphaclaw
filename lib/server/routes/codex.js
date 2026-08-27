const crypto = require("crypto");
const {
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFY_URL,
  CODEX_DEVICE_REDIRECT_URI,
  kCodexDeviceAuthTtlMs,
  kCodexOauthStateTtlMs,
} = require("../constants");

const createCodexOauthState = () => {
  const kCodexOauthStates = new Map();

  const cleanupCodexOauthStates = () => {
    const now = Date.now();
    for (const [state, value] of kCodexOauthStates.entries()) {
      if (!value || now - value.createdAt > kCodexOauthStateTtlMs) {
        kCodexOauthStates.delete(state);
      }
    }
  };

  return { kCodexOauthStates, cleanupCodexOauthStates };
};

// The usercode endpoint has used both snake_case and collapsed field names.
const parseCodexDeviceUsercodeResponse = (json) => {
  const deviceAuthId = String(json?.device_auth_id || json?.deviceAuthId || "");
  const userCode = String(json?.user_code || json?.usercode || "");
  const intervalSec = Number(json?.interval);
  return {
    deviceAuthId,
    userCode,
    intervalMs:
      Number.isFinite(intervalSec) && intervalSec > 0
        ? intervalSec * 1000
        : 5000,
  };
};

const kCodexReconnectLogPatterns = [
  /auth refresh request timed out/i,
  /refresh_token_reused/i,
  /refresh token (has )?(already been )?used/i,
  /invalid[_ -]?refresh[_ -]?token/i,
  /refresh[_ -]?token[_ -]?expired/i,
  /invalid_grant/i,
  /could not validate your token/i,
  /code["']?\s*:\s*["']?token_expired/i,
  /codex.*oauth.*refresh.*fail/i,
  /codex.*auth.*refresh.*fail/i,
];

const getLogLineTimestampMs = (line) => {
  const match = String(line || "").match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const getCodexReconnectStatusFromLogs = (logs, { afterMs = 0 } = {}) => {
  const text = String(logs || "");
  if (!text.trim()) {
    return { needed: false, reason: null };
  }
  const minTimestampMs = Number.isFinite(afterMs) ? Number(afterMs) : 0;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] || "";
    if (kCodexReconnectLogPatterns.some((pattern) => pattern.test(line))) {
      const lineTimestampMs = getLogLineTimestampMs(line);
      if (
        minTimestampMs > 0 &&
        lineTimestampMs !== null &&
        lineTimestampMs < minTimestampMs
      ) {
        continue;
      }
      return {
        needed: true,
        reason: "auth_refresh_failed",
        message:
          "Codex OAuth could not refresh. Reconnect Codex OAuth before using OpenAI Codex-runtime models.",
        lastFailure: line.trim().slice(0, 500),
      };
    }
  }
  return { needed: false, reason: null };
};

const registerCodexRoutes = ({
  app,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  authProfiles,
  codexBrokerService,
  readLogTail,
}) => {
  const { kCodexOauthStates, cleanupCodexOauthStates } =
    createCodexOauthState();

  const persistCodexTokens = async ({
    access,
    refresh,
    expires,
    accountId,
  }) => {
    if (codexBrokerService) {
      return codexBrokerService.storeTokens({
        access,
        refresh,
        expires,
        accountId,
      });
    }
    authProfiles.upsertCodexProfile({ access, refresh, expires, accountId });
    return { brokered: false };
  };

  app.get("/api/codex/status", (req, res) => {
    const profile = authProfiles.getCodexProfile();
    const broker = codexBrokerService?.getStatus?.() || null;
    if (!profile)
      return res.json({ connected: false, ...(broker ? { broker } : {}) });
    let reconnect = { needed: false, reason: null };
    try {
      if (typeof readLogTail === "function") {
        reconnect = getCodexReconnectStatusFromLogs(readLogTail(131072), {
          afterMs:
            typeof profile.updatedAt === "number" ? profile.updatedAt : 0,
        });
      }
    } catch (err) {
      reconnect = { needed: false, reason: null };
    }
    if (broker?.brokered) {
      reconnect = broker.reconnectRequired
        ? {
            needed: true,
            reason: "oauth_broker_grant_invalid",
            message:
              "Codex OAuth needs to be reconnected because its gateway-held grant is no longer usable.",
          }
        : { needed: false, reason: null };
    }
    res.json({
      connected: true,
      profileId: profile.profileId,
      accountId: profile.accountId || null,
      expires: typeof profile.expires === "number" ? profile.expires : null,
      updatedAt:
        typeof profile.updatedAt === "number" ? profile.updatedAt : null,
      needsReconnect: !!reconnect.needed,
      reconnectReason: reconnect.reason || null,
      reconnectMessage: reconnect.message || null,
      lastReconnectFailure: reconnect.lastFailure || null,
      ...(broker ? { broker } : {}),
    });
  });

  app.get("/auth/codex/start", (req, res) => {
    try {
      cleanupCodexOauthStates();
      const redirectUri = CODEX_OAUTH_REDIRECT_URI;
      const { verifier, challenge } = createPkcePair();
      const state = crypto.randomBytes(16).toString("hex");
      kCodexOauthStates.set(state, {
        verifier,
        redirectUri,
        createdAt: Date.now(),
      });

      const authUrl = new URL(CODEX_OAUTH_AUTHORIZE_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", CODEX_OAUTH_SCOPE);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("id_token_add_organizations", "true");
      authUrl.searchParams.set("codex_cli_simplified_flow", "true");
      // Keep this aligned with OpenClaw's own Codex OAuth flow.
      authUrl.searchParams.set("originator", "pi");
      res.redirect(authUrl.toString());
    } catch (err) {
      console.error("[codex] Failed to start OAuth flow:", err);
      res.redirect(
        "/setup?codex=error&message=" + encodeURIComponent(err.message),
      );
    }
  });

  app.get("/auth/codex/callback", async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: '${String(error).replace(/'/g, "\\'")}' }, '*');
      window.close();
    </script><p>Codex auth failed. You can close this window.</p></body></html>`);
    }
    if (!code || !state) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: 'Missing OAuth state/code' }, '*');
      window.close();
    </script><p>Missing OAuth state/code. You can close this window.</p></body></html>`);
    }

    cleanupCodexOauthStates();
    const oauthState = kCodexOauthStates.get(String(state));
    kCodexOauthStates.delete(String(state));
    if (!oauthState) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: 'State mismatch or expired login attempt' }, '*');
      window.close();
    </script><p>State mismatch. You can close this window.</p></body></html>`);
    }

    try {
      const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_OAUTH_CLIENT_ID,
          code: String(code),
          code_verifier: oauthState.verifier,
          redirect_uri: oauthState.redirectUri,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (
        !tokenRes.ok ||
        !json.access_token ||
        !json.refresh_token ||
        typeof json.expires_in !== "number"
      ) {
        throw new Error(`Token exchange failed (${tokenRes.status})`);
      }

      const access = String(json.access_token);
      const refresh = String(json.refresh_token);
      const expires = Date.now() + Number(json.expires_in) * 1000;
      const accountId = getCodexAccountId(access);

      await persistCodexTokens({ access, refresh, expires, accountId });

      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'success' }, '*');
      window.close();
    </script><p>Codex connected. You can close this window.</p></body></html>`);
    } catch (err) {
      console.error("[codex] OAuth callback error:", err);
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: '${String(err.message || "OAuth error").replace(/'/g, "\\'")}' }, '*');
      window.close();
    </script><p>Error: ${String(err.message || "OAuth error")}. You can close this window.</p></body></html>`);
    }
  });

  app.post("/api/codex/exchange", async (req, res) => {
    try {
      cleanupCodexOauthStates();
      const { input } = req.body || {};
      const parsed = parseCodexAuthorizationInput(input);
      const code = String(parsed.code || "");
      const state = String(parsed.state || "");
      if (!code || !state) {
        return res.status(400).json({
          ok: false,
          error:
            "Missing code/state. Paste the full redirect URL from your browser address bar.",
        });
      }
      const oauthState = kCodexOauthStates.get(state);
      if (!oauthState) {
        return res.status(400).json({
          ok: false,
          error: "OAuth state expired or invalid. Start Codex OAuth again.",
        });
      }
      kCodexOauthStates.delete(state);
      const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_OAUTH_CLIENT_ID,
          code,
          code_verifier: oauthState.verifier,
          redirect_uri: oauthState.redirectUri,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (
        !tokenRes.ok ||
        !json.access_token ||
        !json.refresh_token ||
        typeof json.expires_in !== "number"
      ) {
        return res.status(400).json({
          ok: false,
          error: `Token exchange failed (${tokenRes.status})`,
        });
      }
      const access = String(json.access_token);
      const refresh = String(json.refresh_token);
      const expires = Date.now() + Number(json.expires_in) * 1000;
      const accountId = getCodexAccountId(access);
      await persistCodexTokens({ access, refresh, expires, accountId });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[codex] Manual exchange error:", err);
      return res
        .status(500)
        .json({
          ok: false,
          error: err.message || "Codex OAuth exchange failed",
        });
    }
  });

  const kCodexDeviceSessions = new Map();

  const cleanupCodexDeviceSessions = () => {
    const now = Date.now();
    for (const [sessionId, session] of kCodexDeviceSessions.entries()) {
      if (!session || now - session.createdAt > kCodexDeviceAuthTtlMs) {
        kCodexDeviceSessions.delete(sessionId);
      }
    }
  };

  app.post("/api/codex/device/start", async (req, res) => {
    try {
      cleanupCodexDeviceSessions();
      const upstream = await fetch(CODEX_DEVICE_USERCODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      });
      // OpenAI returns 404 when the account/workspace hasn't enabled the
      // device-code beta, not just for unknown routes.
      if (upstream.status === 404) {
        return res.status(400).json({
          ok: false,
          reason: "not_enabled",
          error: "Device code sign-in is not enabled for this ChatGPT account.",
        });
      }
      const json = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        return res.status(400).json({
          ok: false,
          error: `Device auth request failed (${upstream.status})`,
        });
      }
      const parsed = parseCodexDeviceUsercodeResponse(json);
      if (!parsed.deviceAuthId || !parsed.userCode) {
        return res.status(400).json({
          ok: false,
          error: "Device auth response was missing the user code.",
        });
      }
      const sessionId = crypto.randomBytes(16).toString("hex");
      kCodexDeviceSessions.set(sessionId, {
        deviceAuthId: parsed.deviceAuthId,
        userCode: parsed.userCode,
        intervalMs: parsed.intervalMs,
        createdAt: Date.now(),
        polling: false,
      });
      return res.json({
        ok: true,
        sessionId,
        userCode: parsed.userCode,
        verificationUrl: CODEX_DEVICE_VERIFY_URL,
        intervalMs: parsed.intervalMs,
        expiresInMs: kCodexDeviceAuthTtlMs,
      });
    } catch (err) {
      console.error("[codex] Device auth start error:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Device auth start failed",
      });
    }
  });

  app.post("/api/codex/device/poll", async (req, res) => {
    cleanupCodexDeviceSessions();
    const sessionId = String(req.body?.sessionId || "");
    const session = kCodexDeviceSessions.get(sessionId);
    if (!session) return res.json({ ok: true, status: "expired" });
    if (session.polling) return res.json({ ok: true, status: "pending" });
    session.polling = true;
    let upstream;
    try {
      upstream = await fetch(CODEX_DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: session.deviceAuthId,
          user_code: session.userCode,
        }),
      });
    } catch (err) {
      session.polling = false;
      console.error("[codex] Device auth poll error:", err);
      return res.json({ ok: true, status: "pending" });
    }
    session.polling = false;
    // 403/404 mean "not approved yet" in this flow.
    if (upstream.status === 403 || upstream.status === 404) {
      return res.json({ ok: true, status: "pending" });
    }
    const json = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      kCodexDeviceSessions.delete(sessionId);
      return res.json({
        ok: true,
        status: "error",
        error: `Device auth polling failed (${upstream.status})`,
      });
    }
    // The auth server generates the PKCE pair for device auth and returns
    // the verifier alongside the authorization code.
    const code = String(json.authorization_code || json.code || "");
    const verifier = String(json.code_verifier || "");
    if (!code || !verifier) {
      kCodexDeviceSessions.delete(sessionId);
      return res.json({
        ok: true,
        status: "error",
        error: "Device auth response was missing the authorization code.",
      });
    }
    try {
      const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_OAUTH_CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: CODEX_DEVICE_REDIRECT_URI,
        }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (
        !tokenRes.ok ||
        !tokenJson.access_token ||
        !tokenJson.refresh_token ||
        typeof tokenJson.expires_in !== "number"
      ) {
        throw new Error(`Token exchange failed (${tokenRes.status})`);
      }
      const access = String(tokenJson.access_token);
      const refresh = String(tokenJson.refresh_token);
      const expires = Date.now() + Number(tokenJson.expires_in) * 1000;
      const accountId = getCodexAccountId(access);
      await persistCodexTokens({ access, refresh, expires, accountId });
      kCodexDeviceSessions.delete(sessionId);
      return res.json({ ok: true, status: "complete" });
    } catch (err) {
      console.error("[codex] Device auth exchange error:", err);
      kCodexDeviceSessions.delete(sessionId);
      return res.json({
        ok: true,
        status: "error",
        error: err.message || "Device auth exchange failed",
      });
    }
  });

  app.post("/api/codex/disconnect", async (req, res) => {
    try {
      if (!codexBrokerService) {
        const changed = authProfiles.removeCodexProfiles();
        return res.json({ ok: true, changed });
      }
      const result = await codexBrokerService.disconnect();
      return res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      console.error("[codex] Disconnect error:", error);
      return res.status(500).json({
        ok: false,
        changed: false,
        error: error?.code || "disconnect_failed",
      });
    }
  });
};

module.exports = {
  registerCodexRoutes,
  getCodexReconnectStatusFromLogs,
  parseCodexDeviceUsercodeResponse,
};
