const crypto = require("crypto");
const {
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
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
  readLogTail,
}) => {
  const { kCodexOauthStates, cleanupCodexOauthStates } = createCodexOauthState();

  app.get("/api/codex/status", (req, res) => {
    const profile = authProfiles.getCodexProfile();
    if (!profile) return res.json({ connected: false });
    let reconnect = { needed: false, reason: null };
    try {
      if (typeof readLogTail === "function") {
        reconnect = getCodexReconnectStatusFromLogs(readLogTail(131072), {
          afterMs: typeof profile.updatedAt === "number" ? profile.updatedAt : 0,
        });
      }
    } catch (err) {
      reconnect = { needed: false, reason: null };
    }
    res.json({
      connected: true,
      profileId: profile.profileId,
      accountId: profile.accountId || null,
      expires: typeof profile.expires === "number" ? profile.expires : null,
      updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : null,
      needsReconnect: !!reconnect.needed,
      reconnectReason: reconnect.reason || null,
      reconnectMessage: reconnect.message || null,
      lastReconnectFailure: reconnect.lastFailure || null,
    });
  });

  app.get("/auth/codex/start", (req, res) => {
    try {
      cleanupCodexOauthStates();
      const redirectUri = CODEX_OAUTH_REDIRECT_URI;
      const { verifier, challenge } = createPkcePair();
      const state = crypto.randomBytes(16).toString("hex");
      kCodexOauthStates.set(state, { verifier, redirectUri, createdAt: Date.now() });

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
      res.redirect("/setup?codex=error&message=" + encodeURIComponent(err.message));
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

      authProfiles.upsertCodexProfile({ access, refresh, expires, accountId });

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
          error: "Missing code/state. Paste the full redirect URL from your browser address bar.",
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
      authProfiles.upsertCodexProfile({ access, refresh, expires, accountId });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[codex] Manual exchange error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "Codex OAuth exchange failed" });
    }
  });

  app.post("/api/codex/disconnect", (req, res) => {
    const changed = authProfiles.removeCodexProfiles();
    res.json({ ok: true, changed });
  });
};

module.exports = {
  registerCodexRoutes,
  getCodexReconnectStatusFromLogs,
};
