const { getRequestHost } = require("./deployment-surface");

// Browser requests carry an Origin header on every cross-site and same-site
// POST/PUT/PATCH/DELETE and on WebSocket handshakes. The session cookie is
// SameSite=Lax, which does not stop requests from a sibling site (every
// <slug>.teamyou.io instance is the same site until the Public Suffix List
// entry ships), so state-changing requests and WebSocket upgrades must come
// from this instance's own origin. Requests without Origin are non-browser
// clients and pass; their authentication is unchanged.
const kProtectedPathPrefixes = [
  "/api",
  "/setup",
  "/auth",
  "/openclaw",
  // The advanced Control UI acknowledgement form sets its access cookie.
  "/advanced-control",
];
// Public callbacks are called by other origins by design and keep their own
// token or state checks.
const kExemptPathPrefixes = [
  "/hooks",
  "/webhook",
  "/oauth",
  "/gmail-pubsub",
  "/auth/google/callback",
  "/auth/codex/callback",
  "/v1",
];
const kSafeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

// Express routing is case-insensitive and does not resolve dot segments, so
// compare the raw path the same way the router sees it.
const getRawPathname = (req = {}) => {
  const raw = String(req.path || req.url || req.originalUrl || "/").split("?")[0];
  return (raw || "/").toLowerCase();
};

const matchesPathPrefix = (pathname, prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const isOriginProtectedPath = (pathname) =>
  kProtectedPathPrefixes.some((prefix) => matchesPathPrefix(pathname, prefix)) &&
  !kExemptPathPrefixes.some((prefix) => matchesPathPrefix(pathname, prefix));

// The request's own origin, computed like deployment-surface's
// getRequestOrigin (X-Forwarded-Proto/Host from the gateway) with a
// fallback for raw upgrade requests, which have no req.protocol.
const getOwnOrigin = (req = {}) => {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const proto =
    forwardedProto ||
    String(req?.protocol || "").toLowerCase() ||
    (req?.socket?.encrypted ? "https" : "http");
  const host = getRequestHost(req);
  if (!proto || !host) return "";
  try {
    return new URL(`${proto}://${host}`).origin.toLowerCase();
  } catch {
    return "";
  }
};

const normalizeOriginHeader = (value) => {
  const raw = String(value || "").trim();
  if (!raw || raw === "null") return "";
  try {
    const parsed = new URL(raw);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin.toLowerCase();
  } catch {
    return "";
  }
};

// True when the request has no Origin header or names this origin.
// "null" (sandboxed pages, opaque origins) is never same-origin. The host must
// always match. The scheme is enforced when a proxy states it with
// X-Forwarded-Proto; when none does (for example a legacy single-VPS install
// where Tailscale Serve forwards straight to the app), only the host is
// compared, so a missing header cannot turn every same-origin browser POST
// into a refusal. A sibling instance always differs by host.
const isSameOriginOrAbsent = (req = {}) => {
  const header = req?.headers?.origin;
  if (header === undefined || header === null) return true;
  const origin = normalizeOriginHeader(Array.isArray(header) ? header[0] : header);
  if (!origin) return false;
  const requestHost = getRequestHost(req);
  if (!requestHost) return false;
  let parsedOrigin;
  let ownHostForScheme;
  try {
    parsedOrigin = new URL(origin);
    ownHostForScheme = new URL(`${parsedOrigin.protocol}//${requestHost}`).host;
  } catch {
    return false;
  }
  if (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") {
    return false;
  }
  if (parsedOrigin.host !== ownHostForScheme) return false;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (forwardedProto) return parsedOrigin.protocol === `${forwardedProto}:`;
  return true;
};

const createOriginGuard = () => (req, res, next) => {
  const method = String(req.method || "GET").toUpperCase();
  if (kSafeMethods.has(method)) return next();
  if (!isOriginProtectedPath(getRawPathname(req))) return next();
  if (isSameOriginOrAbsent(req)) return next();
  return res.status(403).json({ ok: false, error: "Cross-origin request refused" });
};

module.exports = {
  createOriginGuard,
  getOwnOrigin,
  isOriginProtectedPath,
  isSameOriginOrAbsent,
};
