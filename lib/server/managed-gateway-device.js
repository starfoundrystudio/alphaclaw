const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("./constants");

const kEd25519SpkiPrefixHex = "302a300506032b6570032100";

const kManagedGatewayDeviceScopes = [
  "operator.approvals",
  "operator.pairing",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
];

const kManagedGatewayDeviceApprovalCallerScopes = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
];

let deviceBootstrapModulePromise = null;

const loadDeviceBootstrapModule = async () => {
  deviceBootstrapModulePromise ||= import("openclaw/plugin-sdk/device-bootstrap");
  return deviceBootstrapModulePromise;
};

const normalizeScopeList = (scopes) => {
  const out = new Set();
  for (const scope of Array.isArray(scopes) ? scopes : []) {
    const normalized = String(scope || "").trim();
    if (normalized) out.add(normalized);
  }
  return [...out];
};

const hasAllScopes = (scopes, requiredScopes = kManagedGatewayDeviceScopes) => {
  const available = new Set(normalizeScopeList(scopes));
  return requiredScopes.every((scope) => available.has(scope));
};

const readJsonObject = ({ fsModule, filePath }) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writePrivateJson = ({ fsModule, filePath, value }) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const publicKeyRawBytesFromPem = (publicKeyPem) => {
  const der = crypto.createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  const prefix = Buffer.from(kEd25519SpkiPrefixHex, "hex");
  if (!der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error("OpenClaw gateway device public key is not Ed25519");
  }
  return der.subarray(prefix.length);
};

const publicKeyRawBase64UrlFromPem = (publicKeyPem) =>
  publicKeyRawBytesFromPem(publicKeyPem).toString("base64url");

const deviceIdFromPublicKeyPem = (publicKeyPem) =>
  crypto.createHash("sha256").update(publicKeyRawBytesFromPem(publicKeyPem)).digest("hex");

const privateKeyMatchesPublicKey = ({ privateKeyPem, publicKeyPem }) => {
  const payload = Buffer.from("alphaclaw-managed-gateway-device-check");
  const signature = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem));
  return crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature);
};

const createDeviceIdentity = ({ nowMs }) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  return {
    version: 1,
    deviceId: deviceIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: nowMs,
  };
};

const isUsableDeviceIdentity = (identity) => {
  if (!identity || identity.version !== 1) return false;
  if (!identity.deviceId || !identity.publicKeyPem || !identity.privateKeyPem) return false;
  try {
    const derivedDeviceId = deviceIdFromPublicKeyPem(identity.publicKeyPem);
    return (
      derivedDeviceId === identity.deviceId
      && privateKeyMatchesPublicKey({
        privateKeyPem: identity.privateKeyPem,
        publicKeyPem: identity.publicKeyPem,
      })
    );
  } catch {
    return false;
  }
};

const loadOrCreateDeviceIdentity = ({ fsModule, openclawDir, nowMs }) => {
  const identityPath = path.join(openclawDir, "identity", "device.json");
  const existing = readJsonObject({ fsModule, filePath: identityPath });
  if (isUsableDeviceIdentity(existing)) return { identity: existing, changed: false };

  const identity = createDeviceIdentity({ nowMs });
  writePrivateJson({ fsModule, filePath: identityPath, value: identity });
  return { identity, changed: true };
};

const findPairedManagedDevice = ({ paired, identity, publicKey }) =>
  (Array.isArray(paired) ? paired : []).find((device) => {
    if (String(device?.deviceId || "") !== identity.deviceId) return false;
    return String(device?.publicKey || "") === publicKey;
  }) || null;

const hasCurrentCachedOperatorToken = ({ fsModule, openclawDir, pairedDevice }) => {
  const pairedOperatorToken = pairedDevice?.tokens?.operator;
  if (!pairedOperatorToken?.token || !hasAllScopes(pairedOperatorToken.scopes)) return false;

  const authPath = path.join(openclawDir, "identity", "device-auth.json");
  const cachedAuth = readJsonObject({ fsModule, filePath: authPath });
  const cachedOperatorToken = cachedAuth?.tokens?.operator;
  return Boolean(
    cachedAuth?.version === 1
      && cachedAuth?.deviceId === pairedDevice.deviceId
      && cachedOperatorToken?.token === pairedOperatorToken.token
      && hasAllScopes(cachedOperatorToken.scopes),
  );
};

const writeCachedOperatorToken = ({ fsModule, openclawDir, device, nowMs }) => {
  const operatorToken = device?.tokens?.operator;
  if (!operatorToken?.token) {
    throw new Error("OpenClaw did not return an operator token for the managed gateway device");
  }
  if (!hasAllScopes(operatorToken.scopes)) {
    throw new Error("OpenClaw returned a managed gateway operator token without required scopes");
  }
  const authPath = path.join(openclawDir, "identity", "device-auth.json");
  const existing = readJsonObject({ fsModule, filePath: authPath });
  const tokens = existing?.deviceId === device.deviceId && existing?.tokens
    ? { ...existing.tokens }
    : {};
  tokens.operator = {
    token: operatorToken.token,
    role: "operator",
    scopes: normalizeScopeList(operatorToken.scopes),
    updatedAtMs: nowMs,
  };
  writePrivateJson({
    fsModule,
    filePath: authPath,
    value: {
      version: 1,
      deviceId: device.deviceId,
      tokens,
    },
  });
};

const upsertManagedPendingRequest = ({
  fsModule,
  openclawDir,
  identity,
  publicKey,
  isRepair,
  nowMs,
}) => {
  const pendingPath = path.join(openclawDir, "devices", "pending.json");
  const pendingById = readJsonObject({ fsModule, filePath: pendingPath }) || {};
  for (const [requestId, request] of Object.entries(pendingById)) {
    if (
      String(request?.deviceId || "") === identity.deviceId
      && String(request?.publicKey || "") === publicKey
    ) {
      delete pendingById[requestId];
    }
  }
  const requestId = `alphaclaw-managed-gateway-${crypto.randomUUID()}`;
  pendingById[requestId] = {
    requestId,
    deviceId: identity.deviceId,
    publicKey,
    displayName: "AlphaClaw managed gateway client",
    platform: process.platform,
    deviceFamily: "alphaclaw-managed",
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    roles: ["operator"],
    scopes: [...kManagedGatewayDeviceScopes],
    silent: true,
    isRepair,
    ts: nowMs,
  };
  writePrivateJson({ fsModule, filePath: pendingPath, value: pendingById });
  return requestId;
};

const removePendingRequest = ({ fsModule, openclawDir, requestId }) => {
  const pendingPath = path.join(openclawDir, "devices", "pending.json");
  const pendingById = readJsonObject({ fsModule, filePath: pendingPath });
  if (!pendingById || !pendingById[requestId]) return;
  delete pendingById[requestId];
  writePrivateJson({ fsModule, filePath: pendingPath, value: pendingById });
};

const summarizeApprovalFailure = (approval) => {
  if (!approval) return "Device pairing request not found";
  if (approval.status !== "forbidden") return `Unexpected approval status: ${approval.status}`;
  if (approval.scope) return `${approval.reason}: ${approval.scope}`;
  if (approval.role) return `${approval.reason}: ${approval.role}`;
  return approval.reason || "Device pairing approval forbidden";
};

const ensureManagedGatewayDevicePreapproval = async ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  loadBootstrapModule = loadDeviceBootstrapModule,
  nowMs = Date.now(),
} = {}) => {
  try {
    const bootstrapModule = await loadBootstrapModule();
    if (typeof bootstrapModule?.approveDevicePairing !== "function") {
      throw new Error("OpenClaw device approval helper is unavailable");
    }
    if (typeof bootstrapModule?.listDevicePairing !== "function") {
      throw new Error("OpenClaw device pairing list helper is unavailable");
    }

    const { identity, changed: createdIdentity } = loadOrCreateDeviceIdentity({
      fsModule,
      openclawDir,
      nowMs,
    });
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const pairingList = await bootstrapModule.listDevicePairing(openclawDir);
    const pairedDevice = findPairedManagedDevice({
      paired: pairingList?.paired,
      identity,
      publicKey,
    });

    if (
      pairedDevice
      && hasAllScopes(pairedDevice?.tokens?.operator?.scopes)
      && hasCurrentCachedOperatorToken({ fsModule, openclawDir, pairedDevice })
    ) {
      return {
        ok: true,
        changed: createdIdentity,
        reason: createdIdentity ? "identity-created" : "already-approved",
        deviceId: identity.deviceId,
      };
    }

    const requestId = upsertManagedPendingRequest({
      fsModule,
      openclawDir,
      identity,
      publicKey,
      isRepair: Boolean(pairedDevice),
      nowMs,
    });
    const approval = await bootstrapModule.approveDevicePairing(
      requestId,
      { callerScopes: kManagedGatewayDeviceApprovalCallerScopes },
      openclawDir,
    );
    if (approval?.status !== "approved") {
      removePendingRequest({ fsModule, openclawDir, requestId });
      return {
        ok: false,
        changed: true,
        reason: "approval-failed",
        requestId,
        deviceId: identity.deviceId,
        error: summarizeApprovalFailure(approval),
      };
    }
    writeCachedOperatorToken({
      fsModule,
      openclawDir,
      device: approval.device,
      nowMs,
    });
    return {
      ok: true,
      changed: true,
      reason: pairedDevice ? "repaired" : "approved",
      requestId,
      deviceId: identity.deviceId,
      scopes: normalizeScopeList(approval.device?.tokens?.operator?.scopes),
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      reason: "error",
      error: error.message,
    };
  }
};

module.exports = {
  ensureManagedGatewayDevicePreapproval,
  kManagedGatewayDeviceScopes,
};
