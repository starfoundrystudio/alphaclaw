const fs = require("fs");
const net = require("net");
const {
  kGatewayHopProbePath,
  kGatewayHopProbeStaleMs,
} = require("./constants");

/**
 * Reads the security-gateway hop probe written by the host timer
 * (`alphaclaw-gateway-hop-probe.timer`, installed by clawctl on every
 * security-gateway workload). The probe issues the OAuth broker `status`
 * request over a fresh SSH connection every two minutes and records the
 * outcome in a small JSON file. Clawbridge never opens its own hop for this;
 * it only reads the file, treats it as untrusted input, and reduces it to a
 * fixed-shape snapshot the UI, status APIs and watchdog can rely on.
 *
 * Contract: clawctl docs/provisioning-setup-lifecycle.md, "Gateway Hop Probe".
 */

const kSchemaVersion = 1;
const kProbeName = "oauth_broker_status";
const kMaxProbeFileBytes = 16 * 1024;
const kMaxErrorCodeLength = 64;
const kMaxDetailLength = 500;
const kMaxHostLength = 253;
const kDnsNamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const kGatewayHopState = Object.freeze({
  healthy: "healthy",
  failing: "failing",
  stale: "stale",
  notApplicable: "not_applicable",
  unavailable: "unavailable",
  invalid: "invalid",
});

const stripControlCharacters = (value) =>
  // eslint-disable-next-line no-control-regex
  String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();

const toIsoTimestamp = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
};

const sanitizeErrorCode = (value) => {
  if (value == null) return null;
  if (typeof value !== "string") return "unknown";
  const normalized = stripControlCharacters(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, kMaxErrorCodeLength);
  return normalized || null;
};

const sanitizeDetail = (value) => {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const normalized = stripControlCharacters(value).replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > kMaxDetailLength
    ? `${normalized.slice(0, kMaxDetailLength - 1)}…`
    : normalized;
};

const sanitizeHost = (value) => {
  if (typeof value !== "string") return null;
  const host = stripControlCharacters(value).toLowerCase();
  if (!host || host.length > kMaxHostLength) return null;
  if (net.isIP(host) || kDnsNamePattern.test(host)) return host;
  return null;
};

const isNonNegativeInteger = (value) =>
  Number.isInteger(value) && value >= 0;

const buildSnapshot = ({
  state,
  path: filePath,
  staleAfterMs,
  reason = null,
  ok = null,
  configured = null,
  gatewayHost = null,
  checkedAt = null,
  checkedAgeMs = null,
  lastOkAt = null,
  consecutiveFailures = 0,
  error = null,
  detail = null,
  stale = false,
}) => ({
  state,
  available:
    state !== kGatewayHopState.unavailable && state !== kGatewayHopState.invalid,
  ok,
  configured,
  gatewayHost,
  checkedAt,
  checkedAgeMs,
  lastOkAt,
  consecutiveFailures,
  error,
  detail,
  stale,
  reason,
  path: filePath,
  staleAfterMs,
});

/** Snapshot used when the probe file cannot be consulted at all. */
const buildUnavailableGatewayHopSnapshot = ({
  reason = "unreadable",
  filePath = kGatewayHopProbePath,
  staleMs = kGatewayHopProbeStaleMs,
} = {}) =>
  buildSnapshot({
    state: kGatewayHopState.unavailable,
    path: filePath,
    staleAfterMs: staleMs,
    reason,
  });

const resolveState = ({ ok, configured, stale }) => {
  if (configured === false) return kGatewayHopState.notApplicable;
  if (stale) return kGatewayHopState.stale;
  return ok ? kGatewayHopState.healthy : kGatewayHopState.failing;
};

/**
 * Recomputes the age-derived fields of a previously read snapshot against a
 * new clock reading. Everything else is carried over unchanged.
 */
const refreshGatewayHopSnapshot = (
  snapshot,
  { now = Date.now(), staleMs = kGatewayHopProbeStaleMs } = {},
) => {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  if (!snapshot.available) return { ...snapshot, staleAfterMs: staleMs };
  const checkedAtMs = Date.parse(String(snapshot.checkedAt || ""));
  if (!Number.isFinite(checkedAtMs)) return { ...snapshot, staleAfterMs: staleMs };
  const checkedAgeMs = Math.max(0, now - checkedAtMs);
  const stale = checkedAgeMs > staleMs;
  return {
    ...snapshot,
    checkedAgeMs,
    stale,
    state: resolveState({
      ok: snapshot.ok,
      configured: snapshot.configured,
      stale,
    }),
    staleAfterMs: staleMs,
  };
};

/**
 * Validates a parsed probe document. Returns `{ ok: true, fields }` or
 * `{ ok: false, reason }`. Unknown keys are ignored; the required keys must
 * have the documented types.
 */
const validateProbeDocument = (document) => {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, reason: "invalid_shape" };
  }
  if (document.schema_version !== kSchemaVersion) {
    return { ok: false, reason: "unsupported_schema" };
  }
  if (document.probe !== kProbeName) {
    return { ok: false, reason: "invalid_shape" };
  }
  if (typeof document.ok !== "boolean" || typeof document.configured !== "boolean") {
    return { ok: false, reason: "invalid_shape" };
  }
  const checkedAt = toIsoTimestamp(document.checked_at);
  if (!checkedAt) {
    return { ok: false, reason: "invalid_shape" };
  }
  const rawFailures = document.consecutive_failures;
  if (rawFailures != null && !isNonNegativeInteger(rawFailures)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const error = sanitizeErrorCode(document.error);
  return {
    ok: true,
    fields: {
      ok: document.ok,
      configured: document.configured,
      gatewayHost: sanitizeHost(document.gateway_host),
      checkedAt,
      lastOkAt: toIsoTimestamp(document.last_ok_at),
      consecutiveFailures: rawFailures == null ? 0 : rawFailures,
      error: document.ok ? null : error || "unknown",
      detail: document.ok ? null : sanitizeDetail(document.detail),
    },
  };
};

const readGatewayHopProbe = ({
  fsModule = fs,
  filePath = kGatewayHopProbePath,
  now = Date.now(),
  staleMs = kGatewayHopProbeStaleMs,
} = {}) => {
  const base = { path: filePath, staleAfterMs: staleMs };
  let raw;
  try {
    raw = fsModule.readFileSync(filePath);
  } catch (error) {
    return buildSnapshot({
      ...base,
      state: kGatewayHopState.unavailable,
      reason: error?.code === "ENOENT" ? "missing" : "unreadable",
    });
  }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
  if (bytes.length > kMaxProbeFileBytes) {
    return buildSnapshot({
      ...base,
      state: kGatewayHopState.invalid,
      reason: "too_large",
    });
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    return buildSnapshot({
      ...base,
      state: kGatewayHopState.invalid,
      reason: "not_json",
    });
  }
  const validation = validateProbeDocument(document);
  if (!validation.ok) {
    return buildSnapshot({
      ...base,
      state: kGatewayHopState.invalid,
      reason: validation.reason,
    });
  }
  const { fields } = validation;
  const checkedAgeMs = Math.max(0, now - Date.parse(fields.checkedAt));
  const stale = checkedAgeMs > staleMs;
  return buildSnapshot({
    ...base,
    ...fields,
    checkedAgeMs,
    stale,
    state: resolveState({ ok: fields.ok, configured: fields.configured, stale }),
  });
};

module.exports = {
  buildUnavailableGatewayHopSnapshot,
  kGatewayHopState,
  readGatewayHopProbe,
  refreshGatewayHopSnapshot,
  validateProbeDocument,
};
