const kBuiltInPublicPathPrefixes = ["/hooks", "/webhook", "/oauth"];
const kBuiltInPublicExactPaths = [
  "/gmail-pubsub",
  "/auth/google/callback",
];
const kLoggedInvalidPublicPrefixEntries = new Set();

const normalizeBaseUrl = (value = "") => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};

const normalizeOrigin = (value = "") => {
  const normalized = normalizeBaseUrl(value);
  return normalized ? normalized.toLowerCase() : "";
};

const normalizePathname = (value = "") => {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "/";
  try {
    const parsed = new URL(rawValue, "http://localhost");
    const pathname = String(parsed.pathname || "/");
    if (pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  } catch {
    const pathname = rawValue.split("?")[0] || "/";
    if (pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  }
};

const normalizePublicPathPrefix = (value = "") => {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("/")) return "";
  if (trimmed === "/") return "";
  const normalized = normalizePathname(trimmed);
  return normalized === "/" ? "" : normalized;
};

const getRequestProto = (req = {}) =>
  String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

const getRequestHost = (req = {}) =>
  String(
    req?.headers?.["x-forwarded-host"] ||
      req?.headers?.host ||
      (typeof req.get === "function" ? req.get("host") : "") ||
      "",
  )
    .split(",")[0]
    .trim()
    .toLowerCase();

const getRequestOrigin = (req = {}) => {
  const proto = getRequestProto(req);
  const host = getRequestHost(req);
  if (proto && host) return normalizeBaseUrl(`${proto}://${host}`);
  return "";
};

const getRequestPathname = (req = {}) => {
  return normalizePathname(req?.originalUrl || req?.url || req?.path || "/");
};

const getConfiguredPrivateUiBaseUrl = (env = process.env) => {
  const explicit = normalizeBaseUrl(
    env.ALPHACLAW_SETUP_URL ||
      env.ALPHACLAW_BASE_URL ||
      env.RENDER_EXTERNAL_URL ||
      env.URL ||
      "",
  );
  if (explicit) return explicit;

  const railwayPublicDomain = String(env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  return normalizeBaseUrl(env.RAILWAY_STATIC_URL || "");
};

const getConfiguredPublicCallbackBaseUrl = (env = process.env) =>
  normalizeBaseUrl(env.ALPHACLAW_PUBLIC_BASE_URL || "");

const isStrictIngressRoutingEnabled = (env = process.env) =>
  !!(
    getConfiguredPrivateUiBaseUrl(env) &&
    getConfiguredPublicCallbackBaseUrl(env)
  );

const resolvePrivateUiBaseUrl = ({ req = null, env = process.env } = {}) =>
  getConfiguredPrivateUiBaseUrl(env) ||
  getRequestOrigin(req) ||
  "http://localhost:3000";

const resolvePublicCallbackBaseUrl = ({ req = null, env = process.env } = {}) => {
  if (isStrictIngressRoutingEnabled(env)) {
    return getConfiguredPublicCallbackBaseUrl(env);
  }
  return getRequestOrigin(req) || resolvePrivateUiBaseUrl({ req, env });
};

const getConfiguredPublicPathPrefixes = (env = process.env) => {
  const prefixes = new Set();
  const extraRaw = String(env.ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES || "").trim();
  if (extraRaw) {
    for (const rawEntry of extraRaw.split(",")) {
      const normalized = normalizePublicPathPrefix(rawEntry);
      if (normalized) {
        prefixes.add(normalized);
      } else if (String(rawEntry || "").trim()) {
        const trimmed = String(rawEntry).trim();
        if (!kLoggedInvalidPublicPrefixEntries.has(trimmed)) {
          kLoggedInvalidPublicPrefixEntries.add(trimmed);
          console.warn(
            `[alphaclaw] Ignoring invalid ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES entry: ${trimmed}`,
          );
        }
      }
    }
  }
  return Array.from(prefixes);
};

const matchesPublicPathPrefix = (pathname = "", prefix = "") => {
  const normalizedPath = normalizePathname(pathname);
  const normalizedPrefix = normalizePublicPathPrefix(prefix);
  if (!normalizedPrefix) return false;
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
};

const matchesBuiltInPublicPathPrefix = (pathname = "", prefix = "") => {
  const normalizedPath = normalizePathname(pathname);
  const normalizedPrefix = normalizePublicPathPrefix(prefix);
  if (!normalizedPrefix) return false;
  return normalizedPath.startsWith(`${normalizedPrefix}/`);
};

const isPublicPathAllowed = (pathname = "", env = process.env) => {
  const normalizedPath = normalizePathname(pathname);
  if (kBuiltInPublicExactPaths.includes(normalizedPath)) return true;
  if (
    kBuiltInPublicPathPrefixes.some((prefix) =>
      matchesBuiltInPublicPathPrefix(normalizedPath, prefix),
    )
  ) {
    return true;
  }
  return getConfiguredPublicPathPrefixes(env).some((prefix) =>
    matchesPublicPathPrefix(pathname, prefix),
  );
};

const classifyRequestSurface = (req = {}, env = process.env) => {
  if (!isStrictIngressRoutingEnabled(env)) return "legacy";
  const requestOrigin = normalizeOrigin(getRequestOrigin(req));
  if (!requestOrigin) return "unknown";
  const privateOrigin = normalizeOrigin(getConfiguredPrivateUiBaseUrl(env));
  const publicOrigin = normalizeOrigin(getConfiguredPublicCallbackBaseUrl(env));
  if (requestOrigin === privateOrigin) return "private";
  if (requestOrigin === publicOrigin) return "public";
  return "unknown";
};

const isRequestAllowedForSurface = (req = {}, env = process.env) => {
  const surface = classifyRequestSurface(req, env);
  if (surface === "legacy" || surface === "private") return true;
  if (surface === "public") {
    return isPublicPathAllowed(getRequestPathname(req), env);
  }
  return false;
};

const createPublicIngressGuard = ({ env = process.env } = {}) => (req, res, next) => {
  if (isRequestAllowedForSurface(req, env)) return next();
  return res.status(404).type("text/plain").send("Not found");
};

module.exports = {
  kBuiltInPublicPathPrefixes,
  kBuiltInPublicExactPaths,
  normalizeBaseUrl,
  normalizePathname,
  normalizePublicPathPrefix,
  getRequestOrigin,
  getRequestPathname,
  getConfiguredPrivateUiBaseUrl,
  getConfiguredPublicCallbackBaseUrl,
  getConfiguredPublicPathPrefixes,
  isStrictIngressRoutingEnabled,
  resolvePrivateUiBaseUrl,
  resolvePublicCallbackBaseUrl,
  matchesPublicPathPrefix,
  isPublicPathAllowed,
  classifyRequestSurface,
  isRequestAllowedForSurface,
  createPublicIngressGuard,
};
