const crypto = require("crypto");
const os = require("os");

const {
  kManagedCapabilityContract,
} = require("./managed-capability-contract");

const kAdvancedControlCookieName = "alphaclaw_advanced_access";
const kAdvancedControlAccessPath = "/advanced-control/access";
const kControlUiContract = kManagedCapabilityContract.surfaces.controlUi;

const parseCookies = (req = {}) => {
  const cookies = {};
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const rawCookie of cookieHeader.split(";")) {
    const [name, ...valueParts] = rawCookie.trim().split("=");
    if (name) cookies[name] = valueParts.join("=");
  }
  return cookies;
};

const timingSafeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const resolveInstanceId = (env = process.env) =>
  String(
    env.OPENCLAW_INSTANCE_ID ||
      env.ALPHACLAW_INSTANCE_ID ||
      env.TEAMYOU_INSTANCE_ID ||
      os.hostname() ||
      "unknown",
  ).trim() || "unknown";

const resolveUserIdentity = (req, session) => {
  const tailscaleIdentity = String(
    req?.headers?.["tailscale-user-login"] ||
      req?.headers?.["x-tailscale-user-login"] ||
      "",
  ).trim();
  if (tailscaleIdentity) return tailscaleIdentity;
  return `setup-session:${String(session?.sessionId || "unknown").slice(0, 16)}`;
};

const normalizeAdvancedControlReturnPath = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return kControlUiContract.basePath;
  try {
    const parsed = new URL(raw, "http://localhost");
    if (parsed.origin !== "http://localhost") return kControlUiContract.basePath;
    if (
      parsed.pathname !== kControlUiContract.basePath &&
      !parsed.pathname.startsWith(`${kControlUiContract.basePath}/`)
    ) {
      return kControlUiContract.basePath;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return kControlUiContract.basePath;
  }
};

const createAdvancedControlAccessService = ({
  secret = process.env.SETUP_PASSWORD,
  getAuthorizedSession,
  insertAcknowledgement,
  listAcknowledgements,
  env = process.env,
  now = () => Date.now(),
} = {}) => {
  const signingSecret = String(secret || "");
  const instanceId = resolveInstanceId(env);
  const warningVersion = String(kControlUiContract.warningVersion || "");
  const managedConfigRevision = String(kManagedCapabilityContract.revision || "");

  const signPayload = (payload) =>
    crypto
      .createHmac("sha256", signingSecret)
      .update(`teamyou-advanced-control\0${payload}`)
      .digest("base64url");

  const createToken = (session) => {
    const issuedAt = now();
    const payload = Buffer.from(
      JSON.stringify({
        type: "teamyou-advanced-control",
        iat: issuedAt,
        exp: Number(session.expiresAt),
        sessionId: String(session.sessionId || ""),
        instanceId,
        warningVersion,
        managedConfigRevision,
      }),
    ).toString("base64url");
    return `${payload}.${signPayload(payload)}`;
  };

  const verifyToken = (token, session) => {
    if (!signingSecret || !token || !session) return null;
    const [payload, signature, extra] = String(token).split(".");
    if (!payload || !signature || extra !== undefined) return null;
    if (!timingSafeEqual(signature, signPayload(payload))) return null;
    try {
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (claims?.type !== "teamyou-advanced-control") return null;
      if (!Number.isFinite(claims.exp) || claims.exp <= now()) return null;
      if (claims.exp > Number(session.expiresAt)) return null;
      if (claims.sessionId !== String(session.sessionId || "")) return null;
      if (claims.instanceId !== instanceId) return null;
      if (claims.warningVersion !== warningVersion) return null;
      if (claims.managedConfigRevision !== managedConfigRevision) return null;
      return claims;
    } catch {
      return null;
    }
  };

  const getStatus = (req) => {
    const session = getAuthorizedSession?.(req) || null;
    const token = parseCookies(req)[kAdvancedControlCookieName];
    const claims = verifyToken(token, session);
    return {
      acknowledged: Boolean(claims),
      label: String(kControlUiContract.label || ""),
      warningVersion,
      managedConfigRevision,
      instanceId,
      expiresAt: claims?.exp || null,
    };
  };

  const acknowledge = (req) => {
    const session = getAuthorizedSession?.(req) || null;
    if (!session) {
      const error = new Error("Authenticated Clawbridge session required");
      error.statusCode = 401;
      throw error;
    }
    const acknowledgedAt = new Date(now()).toISOString();
    const userIdentity = resolveUserIdentity(req, session);
    const clientIp = String(
      req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || "",
    );
    const auditId = insertAcknowledgement?.({
      userIdentity,
      sessionId: String(session.sessionId || ""),
      instanceId,
      warningVersion,
      managedConfigRevision,
      clientIp,
      acknowledgedAt,
    });
    return {
      token: createToken(session),
      auditId: Number(auditId || 0),
      acknowledgedAt,
      userIdentity,
      acknowledged: true,
      label: String(kControlUiContract.label || ""),
      warningVersion,
      managedConfigRevision,
      instanceId,
      expiresAt: Number(session.expiresAt),
    };
  };

  const isAuthorized = (req) => getStatus(req).acknowledged;

  const getCookieOptions = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    secure:
      req?.secure === true ||
      String(req?.headers?.["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim()
        .toLowerCase() === "https",
    path: "/",
  });

  const getAuditEvents = ({ limit } = {}) =>
    typeof listAcknowledgements === "function"
      ? listAcknowledgements({ limit })
      : [];

  return {
    acknowledge,
    getAuditEvents,
    getCookieOptions,
    getStatus,
    isAuthorized,
    instanceId,
    managedConfigRevision,
    warningVersion,
  };
};

module.exports = {
  createAdvancedControlAccessService,
  kAdvancedControlAccessPath,
  kAdvancedControlCookieName,
  normalizeAdvancedControlReturnPath,
  parseCookies,
  resolveInstanceId,
  resolveUserIdentity,
};
