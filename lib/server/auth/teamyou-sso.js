const crypto = require("crypto");

// TeamYou-signed owner claims let a managed instance's owner reach Clawbridge
// without a setup password. Contract: docs/clawbridge-teamyou-sso-spec.md.
// TeamYou mirrors kClaimFields and the return_to allowlist; keep them in sync.

const kClaimPurpose = "clawbridge_owner_session";
const kClaimFields = [
  "v",
  "purpose",
  "instance_id",
  "owner_clerk_user_id",
  "email",
  "aud",
  "return_to",
  "jti",
  "iat",
  "exp",
];
const kClockSkewSec = 60;
const kMaxClaimLifetimeSec = 360;
const kMaxClaimLength = 4096;
const kReturnToTabs = new Set([
  "general",
  "chat",
  "models",
  "agents",
  "credentials",
  "envars",
  "webhooks",
  "nodes",
  "cron",
  "usage",
  "doctor",
  "watchdog",
]);
const kControlUiReturnTo = "/openclaw/chat?session=main";
const kKidPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const kInstanceIdPattern = /^inst_[A-Za-z0-9_-]+$/;
const kUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kOwnerIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const kEmailPattern = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

// Exact forms only; anything else is rejected (claims) or replaced by "/"
// (entry links), so a bad bookmark never dead-ends.
const normalizeClawbridgeReturnTo = (value) => {
  const raw = String(value ?? "");
  if (raw === "/" || raw === kControlUiReturnTo) return raw;
  const tabMatch = /^\/#\/([a-z]+)$/.exec(raw);
  if (tabMatch && kReturnToTabs.has(tabMatch[1])) return raw;
  return "";
};

const normalizeOrigin = (value) => {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.origin.toLowerCase();
  } catch {
    return "";
  }
};

const isLocalDevHost = (hostname) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

let cachedKeysSource = null;
let cachedKeys = new Map();

// "kid:base64url(raw Ed25519 public key)[,kid:x…]". Several entries let a
// rotation overlap; malformed entries are skipped rather than failing all.
const parseSsoPublicKeys = (value) => {
  const source = String(value || "").trim();
  if (source === cachedKeysSource) return cachedKeys;
  const keys = new Map();
  for (const entry of source.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const kid = entry.slice(0, separator).trim();
    const x = entry.slice(separator + 1).trim();
    if (!kKidPattern.test(kid) || !/^[A-Za-z0-9_-]{43}$/.test(x)) continue;
    try {
      keys.set(
        kid,
        crypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x },
          format: "jwk",
        }),
      );
    } catch {}
  }
  cachedKeysSource = source;
  cachedKeys = keys;
  return keys;
};

const normalizeEntryUrl = (value, instanceId) => {
  try {
    const parsed = new URL(String(value || "").trim());
    const secure =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLocalDevHost(parsed.hostname));
    if (!secure || parsed.search || parsed.hash) return "";
    if (parsed.pathname !== `/openclaw/clawbridge/${instanceId}`) return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
};

// Read per request: ALPHACLAW_SETUP_URL is written at network finalize, and
// .env reloads update process.env without a restart.
const readTeamYouSsoConfig = (env = process.env) => {
  const instanceId = String(env.OPENCLAW_INSTANCE_ID || "").trim();
  const keys = parseSsoPublicKeys(env.TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS);
  const entryUrl = kInstanceIdPattern.test(instanceId)
    ? normalizeEntryUrl(env.TEAMYOU_CLAWBRIDGE_ENTRY_URL, instanceId)
    : "";
  const enabled = Boolean(entryUrl && keys.size > 0);
  return {
    enabled,
    instanceId: enabled ? instanceId : "",
    entryUrl: enabled ? entryUrl : "",
    keys: enabled ? keys : new Map(),
  };
};

// The setup site may only mint sessions until the dashboard exists; after
// finalize only the dashboard origin is accepted.
const getAcceptedAudiences = (env = process.env) => {
  const setupOrigin = normalizeOrigin(env.ALPHACLAW_SETUP_URL);
  if (setupOrigin) return [setupOrigin];
  const bootstrapOrigin = normalizeOrigin(env.ALPHACLAW_BOOTSTRAP_URL);
  return bootstrapOrigin ? [bootstrapOrigin] : [];
};

const buildTeamYouEntryUrl = (config, returnTo = "/") => {
  if (!config?.enabled) return "";
  const target = normalizeClawbridgeReturnTo(returnTo) || "/";
  if (target === "/") return config.entryUrl;
  const url = new URL(config.entryUrl);
  url.searchParams.set("return_to", target);
  return url.toString();
};

const decodeJsonSegment = (segment) => {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
};

const hasExactKeys = (value, expected) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const fail = (code) => ({ ok: false, code });

const verifyClawbridgeClaim = ({
  claim,
  config,
  requestOrigin,
  env = process.env,
  nowMs = Date.now(),
}) => {
  if (!config?.enabled) return fail("unavailable");
  const token = String(claim || "");
  if (!token || token.length > kMaxClaimLength) return fail("invalid");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("invalid");
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJsonSegment(headerSegment);
  if (
    !header ||
    !hasExactKeys(header, ["alg", "typ", "kid"]) ||
    header.alg !== "EdDSA" ||
    header.typ !== "JWT"
  ) {
    return fail("invalid");
  }
  const key = config.keys.get(String(header.kid));
  if (!key || !/^[A-Za-z0-9_-]+$/.test(signatureSegment)) {
    return fail("invalid");
  }
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      key,
      Buffer.from(signatureSegment, "base64url"),
    );
  } catch {}
  if (!signatureValid) return fail("invalid");

  const claims = decodeJsonSegment(payloadSegment);
  if (
    !claims ||
    !hasExactKeys(claims, kClaimFields) ||
    claims.v !== 1 ||
    claims.purpose !== kClaimPurpose ||
    typeof claims.owner_clerk_user_id !== "string" ||
    !kOwnerIdPattern.test(claims.owner_clerk_user_id) ||
    typeof claims.email !== "string" ||
    claims.email.length > 254 ||
    !kEmailPattern.test(claims.email) ||
    typeof claims.jti !== "string" ||
    !kUuidPattern.test(claims.jti) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp)
  ) {
    return fail("invalid");
  }
  if (claims.instance_id !== config.instanceId) return fail("wrong_instance");

  const audience = normalizeOrigin(claims.aud);
  if (
    !audience ||
    audience !== String(claims.aud).toLowerCase() ||
    audience !== normalizeOrigin(requestOrigin) ||
    !getAcceptedAudiences(env).includes(audience)
  ) {
    return fail("wrong_address");
  }

  const nowSec = Math.floor(nowMs / 1000);
  const lifetime = claims.exp - claims.iat;
  if (lifetime <= 0 || lifetime > kMaxClaimLifetimeSec) return fail("invalid");
  if (claims.iat > nowSec + kClockSkewSec) return fail("invalid");
  if (claims.exp < nowSec - kClockSkewSec) return fail("expired");

  const returnTo = normalizeClawbridgeReturnTo(claims.return_to);
  if (!returnTo) return fail("invalid");

  return {
    ok: true,
    jti: claims.jti,
    expiresAtMs: (claims.exp + kClockSkewSec) * 1000,
    returnTo,
    identity: {
      method: "teamyou",
      sub: claims.owner_clerk_user_id,
      email: claims.email.toLowerCase(),
    },
  };
};

module.exports = {
  kClaimPurpose,
  kClaimFields,
  buildTeamYouEntryUrl,
  getAcceptedAudiences,
  normalizeClawbridgeReturnTo,
  parseSsoPublicKeys,
  readTeamYouSsoConfig,
  verifyClawbridgeClaim,
};
