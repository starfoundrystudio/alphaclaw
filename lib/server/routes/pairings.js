const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("../constants");
const { buildManagedPaths } = require("../internal-files-migration");
const { readOpenclawConfig, writeOpenclawConfig } = require("../openclaw-config");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");

const kAllowedPairingChannels = new Set(["telegram", "discord", "slack", "whatsapp"]);
const kSafePairingArgPattern = /^[\w\-:.]+$/;
const kDevicesListCliTimeoutMs = 15000;
const kDefaultGatewayPort = 18789;
const kPairingRequestTtlMs = 60 * 60 * 1000;
const kDeviceApprovalCallerScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
];
const kManagedBackendAutoApprovalScopes = new Set([
  "operator.approvals",
  "operator.pairing",
]);
const quoteCliArg = (value) => quoteShellArg(value, { strategy: "single" });

let deviceBootstrapModulePromise = null;

const loadDeviceBootstrapModule = async () => {
  deviceBootstrapModulePromise ||= import("openclaw/plugin-sdk/device-bootstrap");
  return deviceBootstrapModulePromise;
};

const defaultApproveDevicePairingDirect = async (requestId, options, baseDir) => {
  const mod = await loadDeviceBootstrapModule();
  if (typeof mod.approveDevicePairing !== "function") {
    throw new Error("OpenClaw device approval helper is unavailable");
  }
  return mod.approveDevicePairing(requestId, options, baseDir);
};

const formatDevicePairingForbiddenMessage = (result) => {
  switch (result?.reason) {
    case "caller-scopes-required":
      return `missing scope: ${result.scope || "callerScopes-required"}`;
    case "caller-missing-scope":
      return `missing scope: ${result.scope || "unknown"}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${result.scope || "unknown"}`;
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${result.role || "unknown"}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${result.scope || "unknown"}`;
    default:
      return "Device pairing approval forbidden";
  }
};

const redactApprovedDevice = (device) => {
  if (!device || typeof device !== "object") return null;
  const safeDevice = { ...device };
  delete safeDevice.publicKey;
  delete safeDevice.tokens;
  return safeDevice;
};

const normalizeDeviceApprovalResult = (approval, requestId) => {
  if (approval?.status === "approved") {
    return {
      ok: true,
      requestId: approval.requestId || requestId,
      device: redactApprovedDevice(approval.device),
    };
  }
  if (approval?.status === "forbidden") {
    return {
      ok: false,
      statusCode: 403,
      error: formatDevicePairingForbiddenMessage(approval),
    };
  }
  return {
    ok: false,
    statusCode: 404,
    error: "Device pairing request not found",
  };
};

const toHttpDeviceApprovalPayload = (result) => {
  const { statusCode, ...payload } = result || {};
  return payload;
};

const normalizeDeviceScopeList = (entry = {}) => {
  const rawScopes = Array.isArray(entry?.scopes)
    ? entry.scopes
    : Array.isArray(entry?.requestedScopes)
      ? entry.requestedScopes
      : [];
  return rawScopes
    .map((scope) => String(scope || "").trim())
    .filter(Boolean);
};

const normalizeDeviceRoleList = (entry = {}) => {
  const roles = Array.isArray(entry?.roles) ? entry.roles : [];
  const role = String(entry?.role || "").trim();
  return [...roles, role]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
};

const isManagedBackendApprovalScopeRequest = (entry = {}) => {
  const clientId = String(entry?.clientId || "").trim().toLowerCase();
  const clientMode = String(entry?.clientMode || "").trim().toLowerCase();
  if (clientId !== "gateway-client" || clientMode !== "backend") return false;

  const roles = normalizeDeviceRoleList(entry);
  if (!roles.includes("operator")) return false;

  const scopes = normalizeDeviceScopeList(entry);
  if (!scopes.includes("operator.approvals")) return false;
  return scopes.every((scope) => kManagedBackendAutoApprovalScopes.has(scope));
};

const isValidDeviceRequestId = (value) => {
  const requestId = String(value || "").trim();
  return Boolean(requestId && kSafePairingArgPattern.test(requestId));
};

const resolvePairingStorePath = ({ openclawDir, channel }) =>
  path.join(openclawDir, "credentials", `${String(channel).trim().toLowerCase()}-pairing.json`);

const readPairingStore = ({ fsModule, filePath }) => {
  try {
    const raw = fsModule.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch {
    return [];
  }
};

const normalizePairingCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizePairingAccountId = (value) => String(value || "").trim() || "default";

const normalizeSlackApprovalUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:slack|user):([A-Z0-9]+)$/i);
  const candidate = prefixed?.[1] || trimmed.match(/^<@([A-Z0-9]+)>$/i)?.[1] || trimmed;
  const upper = String(candidate || "").trim().toUpperCase();
  return /^[UW][A-Z0-9]+$/.test(upper) ? upper : "";
};

const normalizeDiscordApprovalUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:discord|user):(\d+)$/i);
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  const candidate = prefixed?.[1] || mention?.[1] || trimmed;
  return /^\d+$/.test(candidate) ? candidate : "";
};

const normalizeTelegramApprovalUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:telegram|user):(-?\d+)$/i);
  const candidate = prefixed?.[1] || trimmed;
  return /^\d+$/.test(candidate) && !candidate.startsWith("-") ? candidate : "";
};

const normalizeWhatsAppApprovalUserId = (value) => {
  let candidate = String(value || "").trim();
  if (!candidate) return "";
  for (;;) {
    const next = candidate.replace(/^whatsapp:/i, "").trim();
    if (next === candidate) break;
    candidate = next;
  }
  if (/@g\.us$/i.test(candidate) || /@newsletter$/i.test(candidate)) return "";
  const jidMatch = candidate.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i)
    || candidate.match(/^(\d+)@c\.us$/i)
    || candidate.match(/^(\d+)@lid$/i);
  if (jidMatch?.[1]) return jidMatch[1];
  if (candidate.includes("@") || /^[a-z][a-z0-9-]*:/i.test(candidate)) return "";
  const compact = candidate.replace(/[()\s.-]/g, "");
  const normalized = compact.startsWith("+") ? compact.slice(1) : compact;
  return /^\d{2,}$/.test(normalized) ? normalized : "";
};

const kChannelApprovalMirrors = {
  discord: {
    label: "Discord",
    listKind: "execApprovers",
    normalizeRequesterId: normalizeDiscordApprovalUserId,
    ensureEnabled: true,
  },
  slack: {
    label: "Slack",
    listKind: "allowFrom",
    normalizeRequesterId: normalizeSlackApprovalUserId,
  },
  telegram: {
    label: "Telegram",
    listKind: "execApprovers",
    normalizeRequesterId: normalizeTelegramApprovalUserId,
  },
  whatsapp: {
    label: "WhatsApp",
    listKind: "allowFrom",
    normalizeRequesterId: normalizeWhatsAppApprovalUserId,
  },
};

const parseTimestampMs = (value) => {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const mapPairingStoreEntry = ({ entry, channel, nowMs = Date.now() }) => {
  const code = normalizePairingCode(entry?.code || entry?.pairingCode);
  if (!code) return null;
  const createdAt = String(entry?.createdAt || "").trim();
  const createdAtMs = parseTimestampMs(createdAt);
  if (!createdAtMs || nowMs - createdAtMs > kPairingRequestTtlMs) {
    return null;
  }
  return {
    id: code,
    code,
    channel: String(channel || "").trim(),
    accountId: normalizePairingAccountId(entry?.meta?.accountId || entry?.accountId),
    requesterId: String(entry?.id || entry?.requesterId || "").trim(),
    createdAt,
  };
};

const readPendingPairingsFromStore = ({ fsModule, openclawDir, channel, nowMs = Date.now() }) => {
  const filePath = resolvePairingStorePath({ openclawDir, channel });
  return readPairingStore({ fsModule, filePath })
    .map((entry) => mapPairingStoreEntry({ entry, channel, nowMs }))
    .filter(Boolean);
};

const findPendingPairingInStore = ({
  fsModule,
  openclawDir,
  channel,
  code,
  accountId,
  nowMs = Date.now(),
}) => {
  const normalizedCode = normalizePairingCode(code);
  const normalizedAccountId = normalizePairingAccountId(accountId);
  if (!normalizedCode) return null;
  return (
    readPendingPairingsFromStore({ fsModule, openclawDir, channel, nowMs })
      .find((entry) => {
        if (normalizePairingCode(entry?.code || entry?.id) !== normalizedCode) return false;
        return normalizePairingAccountId(entry?.accountId) === normalizedAccountId;
      }) || null
  );
};

const hasEquivalentApprovalUser = (entries, userId, normalizeRequesterId) => {
  const normalizedUserId = normalizeRequesterId(userId);
  if (!normalizedUserId) return false;
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const normalizedEntry = normalizeRequesterId(entry);
    return normalizedEntry === normalizedUserId || String(entry || "").trim() === "*";
  });
};

const appendApprovalUser = (entries, userId, normalizeRequesterId) => {
  const current = Array.isArray(entries) ? entries.slice() : [];
  if (hasEquivalentApprovalUser(current, userId, normalizeRequesterId)) return null;
  return [...current, userId];
};

const resolveChannelApprovalConfigTarget = ({ cfg, channel, accountId }) => {
  if (!cfg.channels || typeof cfg.channels !== "object" || Array.isArray(cfg.channels)) {
    cfg.channels = {};
  }
  if (
    !cfg.channels[channel] ||
    typeof cfg.channels[channel] !== "object" ||
    Array.isArray(cfg.channels[channel])
  ) {
    cfg.channels[channel] = {};
  }

  const channelConfig = cfg.channels[channel];
  const normalizedAccountId = normalizePairingAccountId(accountId);
  const existingAccounts =
    channelConfig.accounts &&
    typeof channelConfig.accounts === "object" &&
    !Array.isArray(channelConfig.accounts)
      ? channelConfig.accounts
      : null;
  const shouldWriteAccountConfig =
    normalizedAccountId !== "default" ||
    Boolean(existingAccounts && Object.keys(existingAccounts).length > 0);

  if (!shouldWriteAccountConfig) {
    return channelConfig;
  }

  if (
    !channelConfig.accounts ||
    typeof channelConfig.accounts !== "object" ||
    Array.isArray(channelConfig.accounts)
  ) {
    channelConfig.accounts = {};
  }
  const existingAccount =
    channelConfig.accounts[normalizedAccountId] &&
    typeof channelConfig.accounts[normalizedAccountId] === "object" &&
    !Array.isArray(channelConfig.accounts[normalizedAccountId])
      ? channelConfig.accounts[normalizedAccountId]
      : {};
  channelConfig.accounts[normalizedAccountId] = existingAccount;
  return existingAccount;
};

const ensureChannelApprovalRequester = ({
  fsModule,
  openclawDir,
  channel,
  accountId,
  requesterId,
}) => {
  const mirror = kChannelApprovalMirrors[channel];
  if (!mirror) return false;

  const userId = mirror.normalizeRequesterId(requesterId);
  if (!userId) return false;

  const cfg = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });

  const target = resolveChannelApprovalConfigTarget({
    cfg,
    channel,
    accountId,
  });

  if (mirror.listKind === "execApprovers") {
    if (
      !target.execApprovals ||
      typeof target.execApprovals !== "object" ||
      Array.isArray(target.execApprovals)
    ) {
      target.execApprovals = {};
    }
    const nextApprovers = appendApprovalUser(
      target.execApprovals.approvers,
      userId,
      mirror.normalizeRequesterId,
    );
    if (!nextApprovers) return false;
    target.execApprovals.approvers = nextApprovers;
    if (mirror.ensureEnabled && target.execApprovals.enabled === undefined) {
      target.execApprovals.enabled = "auto";
    }
  } else {
    const nextAllowFrom = appendApprovalUser(target.allowFrom, userId, mirror.normalizeRequesterId);
    if (!nextAllowFrom) return false;
    target.allowFrom = nextAllowFrom;
  }

  writeOpenclawConfig({ fsModule, openclawDir, config: cfg });
  return true;
};

const mergePendingPairings = (...lists) => {
  const merged = [];
  const seen = new Map();
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      const code = normalizePairingCode(entry?.code || entry?.id);
      const channel = String(entry?.channel || "").trim();
      if (!code || !channel) continue;
      const accountId = normalizePairingAccountId(entry?.accountId);
      const key = `${channel}\u0000${accountId}\u0000${code}`;
      const current = seen.get(key);
      if (!current) {
        const nextEntry = {
          ...entry,
          id: code,
          code,
          channel,
          accountId,
        };
        seen.set(key, nextEntry);
        merged.push(nextEntry);
        continue;
      }
      if (!current.requesterId && entry?.requesterId) {
        current.requesterId = String(entry.requesterId).trim();
      }
      if (!current.createdAt && entry?.createdAt) {
        current.createdAt = String(entry.createdAt).trim();
      }
    }
  }
  return merged;
};

const writePairingStore = ({ fsModule, filePath, requests }) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, JSON.stringify({ version: 1, requests }, null, 2));
};

const removeRequestFromPairingStore = ({ fsModule, openclawDir, channel, code, accountId }) => {
  const filePath = resolvePairingStorePath({ openclawDir, channel });
  const requests = readPairingStore({ fsModule, filePath });
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedAccountId = String(accountId || "").trim().toLowerCase();
  const nextRequests = requests.filter((entry) => {
    const entryCode = String(entry?.code || "").trim().toUpperCase();
    if (entryCode !== normalizedCode) return true;
    if (normalizedAccountId) {
      const entryAccountId = String(entry?.meta?.accountId || "").trim().toLowerCase();
      return entryAccountId !== normalizedAccountId;
    }
    return false;
  });
  if (nextRequests.length !== requests.length) {
    writePairingStore({ fsModule, filePath, requests: nextRequests });
    return true;
  }
  return false;
};

const removeAccountRequestsFromPairingStore = ({ fsModule, openclawDir, channel, accountId }) => {
  const filePath = resolvePairingStorePath({ openclawDir, channel });
  const requests = readPairingStore({ fsModule, filePath });
  if (requests.length === 0) return;
  const normalizedAccountId = String(accountId || "").trim().toLowerCase() || "default";
  const nextRequests = requests.filter((entry) => {
    const entryAccountId = String(entry?.meta?.accountId || "").trim().toLowerCase() || "default";
    return entryAccountId !== normalizedAccountId;
  });
  if (nextRequests.length !== requests.length) {
    writePairingStore({ fsModule, filePath, requests: nextRequests });
  }
};

const buildLocalDeviceCommand = ({
  baseCommand,
  gatewayToken,
  getGatewayPort,
}) => {
  const trimmedBaseCommand = String(baseCommand || "").trim();
  const trimmedGatewayToken = String(gatewayToken || "").trim();
  if (!trimmedBaseCommand || !trimmedGatewayToken) return trimmedBaseCommand;
  const resolvedPort =
    typeof getGatewayPort === "function" ? Number.parseInt(String(getGatewayPort()), 10) : 0;
  const gatewayPort = resolvedPort > 0 ? resolvedPort : kDefaultGatewayPort;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
  return `${trimmedBaseCommand} --url ${quoteCliArg(gatewayUrl)} --token ${quoteCliArg(trimmedGatewayToken)}`;
};

const registerPairingRoutes = ({
  app,
  clawCmd,
  isOnboarded,
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  approveDevicePairingDirect = defaultApproveDevicePairingDirect,
  gatewayToken = "",
  getGatewayPort = null,
}) => {
  let pairingCache = { pending: [], ts: 0, ttlMs: 0 };
  const kPairingCacheTtlMs = 10000;
  const kEmptyPairingCacheTtlMs = 1000;
  const {
    cliDeviceAutoApprovedPath: kCliAutoApproveMarkerPath,
    internalDir: kManagedFilesDir,
  } = buildManagedPaths({
    openclawDir,
  });

  const hasCliAutoApproveMarker = () => fsModule.existsSync(kCliAutoApproveMarkerPath);

  const writeCliAutoApproveMarker = () => {
    fsModule.mkdirSync(kManagedFilesDir, { recursive: true });
    fsModule.writeFileSync(
      kCliAutoApproveMarkerPath,
      JSON.stringify({ approvedAt: new Date().toISOString() }, null, 2),
    );
  };

  const approveDeviceRequestWithAdminScope = async (requestId) => {
    try {
      const approval = await approveDevicePairingDirect(
        requestId,
        { callerScopes: kDeviceApprovalCallerScopes },
        openclawDir,
      );
      return normalizeDeviceApprovalResult(approval, requestId);
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        error: error?.message || "Could not approve device pairing",
      };
    }
  };

  const parsePendingPairings = (stdout, channel) => {
    const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
    const requestLists = [
      ...(Array.isArray(parsed?.requests) ? [parsed.requests] : []),
      ...(Array.isArray(parsed?.pending) ? [parsed.pending] : []),
    ];
    return requestLists
      .flat()
      .map((entry) => {
        const code = String(entry?.code || entry?.pairingCode || "").trim().toUpperCase();
        if (!code) return null;
        return {
          id: code,
          code,
          channel: String(channel || "").trim(),
          accountId:
            String(entry?.meta?.accountId || entry?.accountId || "").trim() || "default",
          requesterId: String(entry?.id || entry?.requesterId || "").trim(),
        };
      })
      .filter(Boolean);
  };

  app.get("/api/pairings", async (req, res) => {
    if (Date.now() - pairingCache.ts < Number(pairingCache.ttlMs || 0)) {
      return res.json({ pending: pairingCache.pending });
    }

    const pending = [];
    const channels = ["telegram", "discord", "slack", "whatsapp"];
    const config = readOpenclawConfig({
      fsModule,
      openclawDir,
      fallback: {},
    });

    for (const ch of channels) {
      const pendingFromStore = readPendingPairingsFromStore({
        fsModule,
        openclawDir,
        channel: ch,
      });
      const isEnabledInConfig = config.channels?.[ch]?.enabled === true;
      if (!isEnabledInConfig && pendingFromStore.length === 0) continue;

      const result = await clawCmd(`pairing list --channel ${ch} --json`, { quiet: true });
      const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (rawOutput) {
        try {
          pending.push(
            ...mergePendingPairings(
              parsePendingPairings(rawOutput, ch),
              pendingFromStore,
            ),
          );
        } catch {
          pending.push(...pendingFromStore);
        }
        continue;
      }
      pending.push(...pendingFromStore);
    }

    pairingCache = {
      pending,
      ts: Date.now(),
      ttlMs: pending.length > 0 ? kPairingCacheTtlMs : kEmptyPairingCacheTtlMs,
    };
    res.json({ pending });
  });

  app.post("/api/pairings/:id/approve", async (req, res) => {
    const channel = String(req.body?.channel || "telegram")
      .trim()
      .toLowerCase();
    const accountId = String(req.body?.accountId || "").trim();
    const pairingId = String(req.params.id || "").trim();
    if (!kAllowedPairingChannels.has(channel)) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported pairing channel "${channel}"`,
      });
    }
    if (!pairingId || !kSafePairingArgPattern.test(pairingId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid pairing id",
      });
    }
    if (accountId && !kSafePairingArgPattern.test(accountId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid account id",
      });
    }
    const storePairing = kChannelApprovalMirrors[channel]
      ? findPendingPairingInStore({
          fsModule,
          openclawDir,
          channel,
          code: pairingId,
          accountId,
        })
      : null;
    const approveCmd = accountId
      ? `pairing approve --channel ${quoteCliArg(channel)} --account ${quoteCliArg(accountId)} ${quoteCliArg(pairingId)}`
      : `pairing approve ${quoteCliArg(channel)} ${quoteCliArg(pairingId)}`;
    const result = await clawCmd(approveCmd);
    if (kChannelApprovalMirrors[channel] && result?.ok) {
      const mirror = kChannelApprovalMirrors[channel];
      const requesterId =
        mirror.normalizeRequesterId(req.body?.requesterId) ||
        mirror.normalizeRequesterId(storePairing?.requesterId);
      if (requesterId) {
        try {
          ensureChannelApprovalRequester({
            fsModule,
            openclawDir,
            channel,
            accountId,
            requesterId,
          });
        } catch (error) {
          console.log(
            `[alphaclaw] Could not mirror ${mirror.label} approval requester ${requesterId}: ${String(error?.message || error).slice(0, 200)}`,
          );
        }
      }
    }
    pairingCache.ts = 0;
    res.json(result);
  });

  app.post("/api/pairings/:id/reject", (req, res) => {
    const channel = String(req.body.channel || "telegram").trim();
    const accountId = String(req.body?.accountId || "").trim();
    try {
      const removed = removeRequestFromPairingStore({
        fsModule,
        openclawDir,
        channel,
        code: req.params.id,
        accountId,
      });
      pairingCache.ts = 0;
      if (removed) {
        console.log(`[alphaclaw] Rejected pairing request ${req.params.id} for ${channel}${accountId ? `/${accountId}` : ""}`);
        return res.json({ ok: true, removed: true });
      }
      return res.status(404).json({
        ok: false,
        removed: false,
        error: "Pairing request not found",
      });
    } catch (error) {
      console.error(`[alphaclaw] Pairing reject error: ${error.message}`);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  let devicePairingCache = { pending: [], cliAutoApproveComplete: false, ts: 0 };
  const kDevicePairingCacheTtl = 3000;

  app.get("/api/devices", async (req, res) => {
    if (!isOnboarded()) {
      return res.json({ pending: [], cliAutoApproveComplete: hasCliAutoApproveMarker() });
    }
    if (Date.now() - devicePairingCache.ts < kDevicePairingCacheTtl) {
      return res.json({
        pending: devicePairingCache.pending,
        cliAutoApproveComplete: devicePairingCache.cliAutoApproveComplete,
      });
    }
    const result = await clawCmd(
      buildLocalDeviceCommand({
        baseCommand: "devices list --json",
        gatewayToken,
        getGatewayPort,
      }),
      {
        quiet: true,
        timeoutMs: kDevicesListCliTimeoutMs,
      },
    );
    if (!result.ok) {
      const failureDetail =
        result.stderr ||
        result.stdout ||
        result.message ||
        (result.signal
          ? `signal ${result.signal}${result.killed ? " (killed)" : ""}`
          : result.code !== undefined && result.code !== null
            ? `exit code ${result.code}`
            : "unknown failure");
      console.log(
        `[alphaclaw] devices list failed: ${String(failureDetail).slice(0, 200)}`,
      );
      return res.json({ pending: [], cliAutoApproveComplete: hasCliAutoApproveMarker() });
    }
    try {
      const parsed = parseJsonObjectFromNoisyOutput(result.stdout);
      const pendingList = Array.isArray(parsed?.pending) ? parsed.pending : [];
      const autoApprovedRequestIds = new Set();
      if (!hasCliAutoApproveMarker()) {
        const firstCliPending = pendingList.find((d) => {
          const clientId = String(d.clientId || "").toLowerCase();
          const clientMode = String(d.clientMode || "").toLowerCase();
          return clientId === "cli" || clientMode === "cli";
        });
        const firstCliPendingId = firstCliPending?.requestId || firstCliPending?.id;
        if (firstCliPendingId) {
          console.log(`[alphaclaw] Auto-approving first CLI device request: ${firstCliPendingId}`);
          const approveResult = await approveDeviceRequestWithAdminScope(firstCliPendingId);
          if (approveResult.ok) {
            writeCliAutoApproveMarker();
            autoApprovedRequestIds.add(String(firstCliPendingId));
          } else {
            console.log(
              `[alphaclaw] CLI auto-approve failed: ${(approveResult.error || "").slice(0, 200)}`,
            );
          }
        }
      }
      for (const pendingDevice of pendingList) {
        const requestId = String(pendingDevice?.requestId || pendingDevice?.id || "").trim();
        if (!requestId || autoApprovedRequestIds.has(requestId)) continue;
        if (!isManagedBackendApprovalScopeRequest(pendingDevice)) continue;
        console.log(
          `[alphaclaw] Auto-approving managed backend approval scope request: ${requestId}`,
        );
        const approveResult = await approveDeviceRequestWithAdminScope(requestId);
        if (approveResult.ok) {
          autoApprovedRequestIds.add(requestId);
        } else {
          console.log(
            `[alphaclaw] Managed backend approval auto-approve failed: ${(approveResult.error || "").slice(0, 200)}`,
          );
        }
      }
      const pending = pendingList
        .filter((d) => !autoApprovedRequestIds.has(String(d.requestId || d.id || "")))
        .map((d) => ({
          id: d.requestId || d.id,
          platform: d.platform || null,
          clientId: d.clientId || null,
          clientMode: d.clientMode || null,
          role: d.role || null,
          scopes: normalizeDeviceScopeList(d),
          ts: d.ts || null,
        }));
      const cliAutoApproveComplete = hasCliAutoApproveMarker();
      devicePairingCache = { pending, cliAutoApproveComplete, ts: Date.now() };
      res.json({ pending, cliAutoApproveComplete });
    } catch {
      res.json({ pending: [], cliAutoApproveComplete: hasCliAutoApproveMarker() });
    }
  });

  app.post("/api/devices/:id/approve", async (req, res) => {
    const requestId = String(req.params.id || "").trim();
    if (!isValidDeviceRequestId(requestId)) {
      return res.status(400).json({ ok: false, error: "Invalid device request id" });
    }
    const result = await approveDeviceRequestWithAdminScope(requestId);
    devicePairingCache.ts = 0;
    res
      .status(result.ok ? 200 : result.statusCode || 500)
      .json(toHttpDeviceApprovalPayload(result));
  });

  app.post("/api/devices/:id/reject", async (req, res) => {
    const requestId = String(req.params.id || "").trim();
    if (!isValidDeviceRequestId(requestId)) {
      return res.status(400).json({ ok: false, error: "Invalid device request id" });
    }
    const result = await clawCmd(
      buildLocalDeviceCommand({
        baseCommand: `devices reject ${quoteCliArg(requestId)}`,
        gatewayToken,
        getGatewayPort,
      }),
    );
    devicePairingCache.ts = 0;
    res.json(result);
  });
};

module.exports = {
  registerPairingRoutes,
  removeAccountRequestsFromPairingStore,
};
