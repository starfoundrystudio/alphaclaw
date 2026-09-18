const crypto = require("crypto");
const { kLoginCleanupIntervalMs } = require("../constants");
const { kIngressSurfaceHeader } = require("../deployment-surface");
const {
  kAdvancedControlCookieName,
} = require("../advanced-control-access");

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

const registerAuthRoutes = ({ app, loginThrottle }) => {
  const SETUP_PASSWORD = String(process.env.SETUP_PASSWORD || "").trim();
  const kAuthMisconfigured = !SETUP_PASSWORD;
  const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

  const signSessionPayload = (payload) =>
    crypto
      .createHmac("sha256", SETUP_PASSWORD)
      .update(payload)
      .digest("base64url");

  const createSessionToken = () => {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + kSessionTtlMs,
        nonce: crypto.randomBytes(16).toString("hex"),
      }),
    ).toString("base64url");
    const signature = signSessionPayload(payload);
    return `${payload}.${signature}`;
  };

  const readSessionToken = (token) => {
    if (!SETUP_PASSWORD || !token || typeof token !== "string") return null;
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
    if (kAuthMisconfigured) {
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
    if (req.body.password !== SETUP_PASSWORD) {
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
    const token = createSessionToken();
    res.cookie("setup_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: kSessionTtlMs,
    });
    res.json({ ok: true });
  });

  setInterval(() => {
    loginThrottle.cleanupLoginAttemptStates();
  }, kLoginCleanupIntervalMs).unref();

  const getAuthorizedSession = (req) => {
    if (kAuthMisconfigured) return false;
    const cookies = cookieParser(req);
    const token = cookies.setup_token;
    return readSessionToken(token);
  };

  const isAuthorizedRequest = (req) => {
    if (kAuthMisconfigured) return false;
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    return Boolean(getAuthorizedSession(req));
  };

  const requireAuth = (req, res, next) => {
    if (isLegacyRuntimeReadyRequest(req)) return next();
    if (kAuthMisconfigured) {
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
    res.json({ authEnabled: !!SETUP_PASSWORD });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("setup_token", { path: "/" });
    res.clearCookie(kAdvancedControlCookieName, { path: "/" });
    res.json({ ok: true });
  });

  app.use("/setup", requireAuth);
  app.use("/api", requireAuth);
  app.use("/auth", requireAuth);

  return { requireAuth, isAuthorizedRequest, getAuthorizedSession };
};

module.exports = { isLegacyRuntimeReadyRequest, registerAuthRoutes };
