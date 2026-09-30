const crypto = require("crypto");
const { kLoginCleanupIntervalMs } = require("../constants");
const {
  getRequestOrigin,
  kIngressSurfaceHeader,
} = require("../deployment-surface");
const {
  buildTeamYouEntryUrl,
  readTeamYouSsoConfig,
  verifyClawbridgeClaim,
} = require("../auth/teamyou-sso");
const {
  getAdvancedControlCookieName,
  getAuthCookieBaseOptions,
  getSessionCookieName,
  usesHostPrefixedCookies,
} = require("../auth/cookie-names");

const isLegacyRuntimeReadyRequest = (req) => {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const requestPath = String(req?.originalUrl || "").split("?", 1)[0];
  if (requestPath !== "/api/onboard/runtime-ready.svg") return false;

  // Older gateway bundles probe the successor private origin before that
  // origin can possess a setup cookie. The new public handoff route is
  // stamped by Caddy and must use the cookie already held on the bootstrap
  // origin.
  return (
    String(req?.headers?.[kIngressSurfaceHeader] || "")
      .trim()
      .toLowerCase() !== "handoff"
  );
};

const passwordsMatch = (candidate, expected) => {
  // Compare fixed-length digests so neither length nor content leaks timing.
  const digest = (value) =>
    crypto.createHash("sha256").update(String(value ?? "")).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
};

const registerAuthRoutes = ({
  app,
  loginThrottle,
  sessionSigningKey,
  ssoClaimStore = null,
  env = process.env,
}) => {
  const SETUP_PASSWORD = String(env.SETUP_PASSWORD || "").trim();
  const signingKey = String(sessionSigningKey ?? SETUP_PASSWORD);
  const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000;
  const getSsoConfig = () => readTeamYouSsoConfig(env);
  // Managed instances may have no password at all once TeamYou sign-in is
  // configured; auth is only misconfigured when neither method can work.
  const isAuthMisconfigured = () =>
    !signingKey || (!SETUP_PASSWORD && !getSsoConfig().enabled);

  const signSessionPayload = (payload) =>
    crypto
      .createHmac("sha256", signingKey)
      .update(payload)
      .digest("base64url");

  const createSessionToken = (identity = null) => {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + kSessionTtlMs,
        nonce: crypto.randomBytes(16).toString("hex"),
        method: identity?.method === "teamyou" ? "teamyou" : "password",
        ...(identity?.method === "teamyou"
          ? { sub: identity.sub, email: identity.email }
          : {}),
      }),
    ).toString("base64url");
    const signature = signSessionPayload(payload);
    return `${payload}.${signature}`;
  };

  const setSessionCookie = (req, res, token) => {
    res.cookie(getSessionCookieName(env), token, {
      ...getAuthCookieBaseOptions(req, env),
      httpOnly: true,
      sameSite: "lax",
      maxAge: kSessionTtlMs,
    });
  };

  const readSessionToken = (token) => {
    if (!signingKey || !token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    const expectedSignature = signSessionPayload(payload);
    const expectedBuffer = Buffer.from(expectedSignature);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length) return null;
    if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (!Number.isFinite(parsed?.exp) || parsed.exp <= Date.now()) return null;
      if (!Number.isFinite(parsed?.iat) || !String(parsed?.nonce || "")) return null;
      return {
        sessionId: String(parsed.nonce),
        issuedAt: Number(parsed.iat),
        expiresAt: Number(parsed.exp),
        method: parsed.method === "teamyou" ? "teamyou" : "password",
        email: parsed.method === "teamyou" ? String(parsed.email || "") : "",
      };
    } catch {
      return null;
    }
  };

  const cookieParser = (req) => {
    const cookies = {};
    const cookieHeader =
      req && req.headers && typeof req.headers.cookie === "string"
        ? req.headers.cookie
        : "";
    cookieHeader.split(";").forEach((c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) cookies[k] = v.join("=");
    });
    return cookies;
  };

  app.post("/api/auth/login", (req, res) => {
    if (!SETUP_PASSWORD && getSsoConfig().enabled) {
      return res.status(404).json({
        ok: false,
        error: "Password sign-in is not available. Open Clawbridge from TeamYou.",
      });
    }
    if (isAuthMisconfigured()) {
      return res.status(503).json({
        ok: false,
        error:
          "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
      });
    }
    const now = Date.now();
    const clientKey = loginThrottle.getClientKey(req);
    const state = loginThrottle.getOrCreateLoginAttemptState(clientKey, now);
    const throttle = loginThrottle.evaluateLoginThrottle(state, now);
    if (throttle.blocked) {
      res.set("Retry-After", String(throttle.retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again shortly.",
        retryAfterSec: throttle.retryAfterSec,
      });
    }
    if (!passwordsMatch(req.body?.password, SETUP_PASSWORD)) {
      const failure = loginThrottle.recordLoginFailure(state, now);
      if (failure.locked) {
        const retryAfterSec = Math.max(1, Math.ceil(failure.lockMs / 1000));
        res.set("Retry-After", String(retryAfterSec));
        return res.status(429).json({
          ok: false,
          error: "Too many attempts. Try again shortly.",
          retryAfterSec,
        });
      }
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }
    loginThrottle.recordLoginSuccess(clientKey);
    setSessionCookie(req, res, createSessionToken());
    res.json({ ok: true });
  });

  // TeamYou sign-in: the claim arrives in the URL on a top-level navigation
  // from TeamYou, is burned before any session exists, and the browser is
  // sent on without the claim in its history or a Referer.
  app.get("/auth/teamyou", (req, res) => {
    const config = getSsoConfig();
    if (!config.enabled) return res.status(404).type("text/plain").send("Not found");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Cache-Control", "no-store");
    const redirectToLogin = (code) =>
      res.redirect(303, `/login.html?sso_error=${encodeURIComponent(code)}`);

    const now = Date.now();
    const clientKey = loginThrottle.getClientKey(req);
    const state = loginThrottle.getOrCreateLoginAttemptState(clientKey, now);
    if (loginThrottle.evaluateLoginThrottle(state, now).blocked) {
      return redirectToLogin("throttled");
    }

    const result = verifyClawbridgeClaim({
      claim: req.query?.claim,
      config,
      requestOrigin: getRequestOrigin(req),
      env,
      nowMs: now,
    });
    if (!result.ok) {
      loginThrottle.recordLoginFailure(state, now);
      return redirectToLogin(result.code);
    }
    let consumed = false;
    try {
      consumed = ssoClaimStore?.consume({
        jti: result.jti,
        expiresAt: result.expiresAtMs,
      }) === true;
    } catch (error) {
      console.error(`[alphaclaw] TeamYou sign-in store failed: ${error.message}`);
      return redirectToLogin("unavailable");
    }
    if (!consumed) {
      loginThrottle.recordLoginFailure(state, now);
      return redirectToLogin("used");
    }
    loginThrottle.recordLoginSuccess(clientKey);
    setSessionCookie(req, res, createSessionToken(result.identity));
    return res.redirect(303, result.returnTo);
  });

  setInterval(() => {
    loginThrottle.cleanupLoginAttemptStates();
    try {
      ssoClaimStore?.prune(Date.now());
    } catch {}
  }, kLoginCleanupIntervalMs).unref();

  const getAuthorizedSession = (req) => {
    if (isAuthMisconfigured()) return false;
    const cookies = cookieParser(req);
    const token = cookies[getSessionCookieName(env)];
    return readSessionToken(token);
  };

  const isAuthorizedRequest = (req) => {
    if (isAuthMisconfigured()) return false;
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    return Boolean(getAuthorizedSession(req));
  };

  const requireAuth = (req, res, next) => {
    if (isLegacyRuntimeReadyRequest(req)) return next();
    if (isAuthMisconfigured()) {
      if (req.originalUrl.startsWith("/api/")) {
        return res.status(503).json({
          error:
            "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
        });
      }
      return res
        .status(503)
        .send(
          "Setup auth is not configured. Set SETUP_PASSWORD in your deployment environment and restart.",
        );
    }
    if (req.path.startsWith("/auth/google/callback")) return next();
    if (req.path.startsWith("/auth/codex/callback")) return next();
    if (isAuthorizedRequest(req)) return next();
    if (req.originalUrl.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login.html");
  };

  app.get("/api/auth/status", (req, res) => {
    const config = getSsoConfig();
    const session = getAuthorizedSession(req);
    res.json({
      authEnabled: !isAuthMisconfigured(),
      methods: {
        password: !!SETUP_PASSWORD,
        teamyou: config.enabled
          ? {
              entryUrl: buildTeamYouEntryUrl(config, "/"),
            }
          : null,
      },
      identity: session
        ? {
            method: session.method,
            ...(session.email ? { email: session.email } : {}),
          }
        : null,
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    const clearOptions = usesHostPrefixedCookies(env)
      ? { path: "/", secure: true }
      : { path: "/" };
    res.clearCookie(getSessionCookieName(env), clearOptions);
    res.clearCookie(getAdvancedControlCookieName(env), clearOptions);
    res.json({ ok: true });
  });

  app.use("/setup", requireAuth);
  app.use("/api", requireAuth);
  app.use("/auth", requireAuth);

  return { requireAuth, isAuthorizedRequest, getAuthorizedSession };
};

module.exports = { isLegacyRuntimeReadyRequest, registerAuthRoutes };
