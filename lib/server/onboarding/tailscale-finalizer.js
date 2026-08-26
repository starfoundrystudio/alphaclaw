const { createHash } = require("crypto");

const {
  kConnectivityModeLocal,
  kConnectivityModeSecurityGateway,
  createGatewayTailscaleFinalizer,
  getConnectivityMode,
  parseGatewayStoredResult,
} = require("./gateway-tailscale-finalizer");
const {
  getEnvValue,
  getEnvVar,
  normalizeDnsName,
  upsertEnvVar,
} = require("./tailscale-env");

const kTailscaleTag = "tag:openclaw";
const kCloudOpsEmail = "cloud-ops@teamyou.ai";
const kDefaultTailnet = "-";
const kDefaultHostname = "alphaclaw";
const kDefaultServePort = 443;
const kDefaultFunnelPort = 8443;
const kAuthKeyExpirySeconds = 60 * 60;
const kTailscaleExposeWrapper = "/usr/local/sbin/alphaclaw-tailscale-expose";
const kExposeWrapperOperations = new Set([
  "configure-all",
  "configure-ui",
  "configure-pages",
  "configure-funnel",
  "status",
]);

const shellQuote = (value = "") => `'${String(value).replace(/'/g, "'\\''")}'`;

const getErrorText = (error) =>
  [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n");

const isMissingExposeWrapperError = (error) => {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("command not found") ||
    text.includes("permission denied") ||
    text.includes("not in the sudoers") ||
    text.includes("a password is required") ||
    text.includes("sudo: a terminal is required")
  );
};

const createMissingExposeWrapperError = (cause) => {
  const detail = getErrorText(cause).trim();
  const error = new Error(
    [
      "Tailscale exposure wrapper is not available or cannot run.",
      "This host was likely provisioned with an older clawctl; reprovision or upgrade the host bootstrap so /usr/local/sbin/alphaclaw-tailscale-expose is installed and sudo NOPASSWD is configured.",
      detail ? `Details: ${detail}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  error.cause = cause;
  return error;
};

const runTailscaleExposeWrapper = async (shellCmd, operation = "configure-all") => {
  if (!kExposeWrapperOperations.has(operation)) {
    throw new Error(`Unsupported Tailscale exposure operation: ${operation}`);
  }
  const command = `sudo -n ${kTailscaleExposeWrapper} ${operation}`;
  try {
    return await shellCmd(command, { timeoutMs: 30000 });
  } catch (error) {
    if (isMissingExposeWrapperError(error)) {
      throw createMissingExposeWrapperError(error);
    }
    throw error;
  }
};

const runTailscaleCli = async (shellCmd, cmd, opts = {}) =>
  shellCmd(cmd, opts);

const normalizeStringList = (value = []) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );

const ensureListValues = (target, values) => {
  const next = normalizeStringList(target);
  let changed = false;
  for (const value of values) {
    if (!next.includes(value)) {
      next.push(value);
      changed = true;
    }
  }
  return { values: next, changed };
};

const sameStringSet = (left, right) => {
  const a = normalizeStringList(left).sort();
  const b = normalizeStringList(right).sort();
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
};

const ensureTagOwner = (policy) => {
  if (!policy.tagOwners || typeof policy.tagOwners !== "object") {
    policy.tagOwners = {};
  }
  const current = normalizeStringList(policy.tagOwners[kTailscaleTag]);
  const owners = current.length > 0 ? current : ["autogroup:admin"];
  const result = ensureListValues(owners, ["autogroup:admin"]);
  policy.tagOwners[kTailscaleTag] = result.values;
  return result.changed || current.length === 0;
};

const ensureFunnelNodeAttr = (policy) => {
  if (!Array.isArray(policy.nodeAttrs)) policy.nodeAttrs = [];
  for (const entry of policy.nodeAttrs) {
    if (!entry || typeof entry !== "object") continue;
    if (!normalizeStringList(entry.target).includes(kTailscaleTag)) continue;
    const result = ensureListValues(entry.attr, ["funnel"]);
    entry.attr = result.values;
    return result.changed;
  }
  policy.nodeAttrs.push({
    target: [kTailscaleTag],
    attr: ["funnel"],
  });
  return true;
};

const ensureGrantAccess = (policy) => {
  if (!Array.isArray(policy.grants)) policy.grants = [];
  const desiredSrc = ["autogroup:admin", kCloudOpsEmail];
  const desiredDst = [kTailscaleTag];
  const desiredIp = ["tcp:443", "tcp:8443", "tcp:22"];
  for (const grant of policy.grants) {
    if (!grant || typeof grant !== "object") continue;
    if (
      sameStringSet(grant.src, desiredSrc) &&
      sameStringSet(grant.dst, desiredDst)
    ) {
      const result = ensureListValues(grant.ip, desiredIp);
      grant.ip = result.values;
      return result.changed;
    }
  }
  policy.grants.push({
    src: desiredSrc,
    dst: desiredDst,
    ip: desiredIp,
  });
  return true;
};

const ensureAclAccess = (policy) => {
  if (!Array.isArray(policy.acls)) policy.acls = [];
  const desiredSrc = ["autogroup:admin", kCloudOpsEmail];
  const desiredDst = [
    `${kTailscaleTag}:443`,
    `${kTailscaleTag}:8443`,
    `${kTailscaleTag}:22`,
  ];
  for (const acl of policy.acls) {
    if (!acl || typeof acl !== "object") continue;
    if (acl.action !== "accept" || !sameStringSet(acl.src, desiredSrc)) {
      continue;
    }
    const result = ensureListValues(acl.dst, desiredDst);
    acl.dst = result.values;
    return result.changed;
  }
  policy.acls.push({
    action: "accept",
    src: desiredSrc,
    dst: desiredDst,
  });
  return true;
};

const ensureSshPolicy = (policy) => {
  if (!Array.isArray(policy.ssh)) policy.ssh = [];
  const desiredSrc = ["autogroup:admin", kCloudOpsEmail];
  const desiredDst = [kTailscaleTag];
  const desiredUsers = ["root", "alphaclaw"];
  for (const sshRule of policy.ssh) {
    if (!sshRule || typeof sshRule !== "object") continue;
    if (
      sshRule.action !== "accept" ||
      !sameStringSet(sshRule.dst, desiredDst) ||
      !sameStringSet(sshRule.users, desiredUsers)
    ) {
      continue;
    }
    const result = ensureListValues(sshRule.src, desiredSrc);
    sshRule.src = result.values;
    return result.changed;
  }
  policy.ssh.push({
    action: "accept",
    src: desiredSrc,
    dst: desiredDst,
    users: desiredUsers,
  });
  return true;
};

const ensureAgentVaultServicePolicy = (policy, serviceName) => {
  if (!serviceName) return false;
  let changed = false;
  if (!policy.autoApprovers || typeof policy.autoApprovers !== "object") {
    policy.autoApprovers = {};
  }
  if (
    !policy.autoApprovers.services ||
    typeof policy.autoApprovers.services !== "object"
  ) {
    policy.autoApprovers.services = {};
  }
  const approvers = ensureListValues(
    policy.autoApprovers.services[serviceName],
    [kTailscaleTag],
  );
  policy.autoApprovers.services[serviceName] = approvers.values;
  changed = approvers.changed || changed;

  const desiredSrc = ["autogroup:admin", kCloudOpsEmail];
  if (Array.isArray(policy.grants)) {
    const existing = policy.grants.find(
      (grant) =>
        grant &&
        typeof grant === "object" &&
        sameStringSet(grant.src, desiredSrc) &&
        sameStringSet(grant.dst, [serviceName]),
    );
    if (existing) {
      const ports = ensureListValues(existing.ip, ["tcp:443"]);
      existing.ip = ports.values;
      changed = ports.changed || changed;
    } else {
      policy.grants.push({
        src: desiredSrc,
        dst: [serviceName],
        ip: ["tcp:443"],
      });
      changed = true;
    }
  } else {
    if (!Array.isArray(policy.acls)) policy.acls = [];
    const destination = `${serviceName}:443`;
    const existing = policy.acls.find(
      (acl) =>
        acl &&
        typeof acl === "object" &&
        acl.action === "accept" &&
        sameStringSet(acl.src, desiredSrc),
    );
    if (existing) {
      const destinations = ensureListValues(existing.dst, [destination]);
      existing.dst = destinations.values;
      changed = destinations.changed || changed;
    } else {
      policy.acls.push({
        action: "accept",
        src: desiredSrc,
        dst: [destination],
      });
      changed = true;
    }
  }
  return changed;
};

const ensureAlphaclawTailscalePolicy = (
  policy = {},
  { tailscaleSsh = true, agentVaultServiceName = "" } = {},
) => {
  const nextPolicy = JSON.parse(JSON.stringify(policy || {}));
  let changed = false;
  changed = ensureTagOwner(nextPolicy) || changed;
  changed = ensureFunnelNodeAttr(nextPolicy) || changed;
  changed =
    (Array.isArray(nextPolicy.grants)
      ? ensureGrantAccess(nextPolicy)
      : ensureAclAccess(nextPolicy)) || changed;
  if (tailscaleSsh) {
    changed = ensureSshPolicy(nextPolicy) || changed;
  }
  changed =
    ensureAgentVaultServicePolicy(nextPolicy, agentVaultServiceName) || changed;
  return { policy: nextPolicy, changed };
};

const getTailscaleApiTokenValidation = (token = "") => {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return { ok: false, error: "Tailscale API access token is required" };
  }
  if (!normalized.startsWith("tskey-api-")) {
    return {
      ok: false,
      error: "Tailscale API access token must start with tskey-api-",
    };
  }
  return { ok: true, token: normalized };
};

const parseJsonResponse = async (res) => {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const createTailscaleApiClient = ({
  token,
  fetchImpl = global.fetch,
  baseUrl = "https://api.tailscale.com/api/v2",
} = {}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Tailscale API client requires fetch support");
  }

  const request = async (apiPath, { method = "GET", body, headers = {} } = {}) => {
    const res = await fetchImpl(`${baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await parseJsonResponse(res);
    if (!res.ok) {
      const message = String(data?.message || data?.error || `HTTP ${res.status}`);
      throw new Error(`Tailscale API ${method} ${apiPath} failed: ${message}`);
    }
    return { data, headers: res.headers };
  };

  return { request };
};

const resolveDeviceId = async ({
  status,
  api,
  tailnet,
  dnsName,
  requireTailnetMembership = false,
}) => {
  const directId = String(status?.Self?.ID || status?.Self?.StableID || "").trim();
  if (directId && !requireTailnetMembership) return directId;

  const deviceResult = await api.request(
    `/tailnet/${encodeURIComponent(tailnet)}/devices`,
  );
  const devices = Array.isArray(deviceResult.data?.devices)
    ? deviceResult.data.devices
    : [];
  const normalizedDns = normalizeDnsName(dnsName).toLowerCase();
  const match = devices.find((device) => {
    const deviceId = String(device?.id || "").trim();
    const nodeId = String(device?.nodeId || "").trim();
    const deviceDns = normalizeDnsName(device?.name || device?.hostname || "").toLowerCase();
    const idMatches =
      !directId || deviceId === directId || nodeId === directId;
    const dnsMatches = !normalizedDns || deviceDns === normalizedDns;
    return idMatches && dnsMatches;
  });
  return String(match?.id || match?.nodeId || "").trim();
};

const createAuthKey = async ({ api, tailnet }) => {
  const result = await api.request(`/tailnet/${encodeURIComponent(tailnet)}/keys`, {
    method: "POST",
    body: {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: [kTailscaleTag],
          },
        },
      },
      expirySeconds: kAuthKeyExpirySeconds,
      description: "Clawbridge one-time setup key",
    },
  });
  const key = String(result.data?.key || "").trim();
  if (!key) throw new Error("Tailscale API did not return an auth key");
  return key;
};

const readTailscaleStatus = async ({ shellCmd, required = true }) => {
  try {
    const statusRaw = await shellCmd("tailscale status --json", {
      timeoutMs: 30000,
      logStdout: false,
    });
    return JSON.parse(statusRaw || "{}");
  } catch (error) {
    if (!required) return null;
    if (error instanceof SyntaxError) {
      throw new Error("Tailscale status returned invalid JSON");
    }
    throw error;
  }
};

const fetchAndApplyPolicy = async ({
  api,
  tailnet,
  tailscaleSsh = true,
  agentVaultServiceName = "",
}) => {
  const current = await api.request(`/tailnet/${encodeURIComponent(tailnet)}/acl`, {
    headers: { Accept: "application/json" },
  });
  const { policy, changed } = ensureAlphaclawTailscalePolicy(current.data || {}, {
    tailscaleSsh,
    agentVaultServiceName,
  });
  await api.request(`/tailnet/${encodeURIComponent(tailnet)}/acl/validate`, {
    method: "POST",
    body: policy,
  });
  if (changed) {
    const etag =
      typeof current.headers?.get === "function" ? current.headers.get("etag") : "";
    await api.request(`/tailnet/${encodeURIComponent(tailnet)}/acl`, {
      method: "POST",
      body: policy,
      headers: etag ? { "If-Match": etag } : {},
    });
  }
  return { policyChanged: changed };
};

const buildAgentVaultServiceIdentity = ({ instanceId }) => {
  const normalized = String(instanceId || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error("Agent Vault Service requires an instance ID");
  }
  const prefix = "agent-vault-";
  const digest = createHash("sha256")
    .update(String(instanceId))
    .digest("hex")
    .slice(0, 10);
  const maxInstanceLength = 63 - prefix.length - 1 - digest.length;
  const instanceLabel = normalized
    .slice(0, maxInstanceLength)
    .replace(/-+$/g, "");
  const label = `${prefix}${instanceLabel}-${digest}`;
  return { name: `svc:${label}`, label };
};

const ensureAgentVaultService = async ({ api, tailnet, serviceName }) => {
  const tailnetPath = `/tailnet/${encodeURIComponent(tailnet)}/vip-services`;
  const current = await api.request(tailnetPath);
  const services = Array.isArray(current.data?.vipServices)
    ? current.data.vipServices
    : [];
  const existing = services.find((service) => service?.name === serviceName);
  const body = {
    name: serviceName,
    comment: "Clawbridge managed Agent Vault",
    ports: ["tcp:443"],
    ...(Array.isArray(existing?.addrs) && existing.addrs.length > 0
      ? { addrs: existing.addrs }
      : {}),
    ...(Array.isArray(existing?.tags) ? { tags: existing.tags } : {}),
  };
  const unchanged =
    existing &&
    existing.comment === body.comment &&
    sameStringSet(existing.ports, body.ports);
  if (!unchanged) {
    await api.request(
      `${tailnetPath}/${encodeURIComponent(serviceName)}`,
      { method: "PUT", body },
    );
  }
  return { serviceName, changed: !unchanged };
};

const ensureTailnetHttpsEnabled = async ({ api, tailnet }) => {
  await api.request(`/tailnet/${encodeURIComponent(tailnet)}/settings`, {
    method: "PATCH",
    body: { httpsEnabled: true },
  });
  return { httpsEnabled: true };
};

const getTeamYouWritebackConfig = ({ env = process.env, envVars = [] } = {}) => {
  const callbackUrl = getEnvValue(env, envVars, [
    "OPENCLAW_WEBHOOK_URL",
    "TEAMYOU_FINALIZE_CALLBACK_URL",
  ]);
  if (!callbackUrl) return { skipped: true };
  const callbackToken = getEnvValue(env, envVars, [
    "OPENCLAW_WEBHOOK_TOKEN",
    "TEAMYOU_FINALIZE_CALLBACK_TOKEN",
  ]);
  if (!callbackToken) {
    throw new Error("TeamYou writeback failed: OPENCLAW_WEBHOOK_TOKEN is required");
  }
  const instanceId = getEnvValue(env, envVars, [
    "OPENCLAW_INSTANCE_ID",
    "ALPHACLAW_INSTANCE_ID",
    "TEAMYOU_INSTANCE_ID",
  ]);
  if (!instanceId) {
    throw new Error("TeamYou writeback failed: OPENCLAW_INSTANCE_ID is required");
  }
  return {
    skipped: false,
    callbackUrl,
    callbackToken,
    instanceId,
  };
};

const callTeamYouWriteback = async ({
  fetchImpl = global.fetch,
  setupUrl,
  publicBaseUrl,
  dnsName,
  deviceId = "",
  tailscaleHostRole = "",
  agentVaultOperatorUrl = "",
  writebackConfig,
}) => {
  if (writebackConfig?.skipped) return { skipped: true };
  const res = await fetchImpl(writebackConfig.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${writebackConfig.callbackToken}`,
    },
    body: JSON.stringify({
      type: "instance.network_finalized",
      instance_id: writebackConfig.instanceId,
      setup_url: setupUrl,
      public_base_url: publicBaseUrl,
      tailscale_dns: dnsName,
      ...(deviceId ? { tailscale_device_id: deviceId } : {}),
      ...(tailscaleHostRole
        ? { tailscale_host_role: tailscaleHostRole }
        : {}),
      ...(agentVaultOperatorUrl
        ? { agent_vault_operator_url: agentVaultOperatorUrl }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`TeamYou writeback failed with HTTP ${res.status}`);
  }
  return { skipped: false };
};

const getPositivePort = (value, fallback, label) => {
  const rawValue =
    value === undefined || value === null || value === "" ? fallback : value;
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} is invalid`);
  }
  return port;
};

const createTailscaleFinalizer = ({
  shellCmd,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  fetchImpl = global.fetch,
  env = process.env,
  gatewayTailscaleClient,
  gatewayTailscaleClientFactory,
} = {}) => {
  const finalizeLocalTailscaleOnboarding = async ({
    api,
    tailnet,
    hostname,
    funnelPort,
    envVars,
    writebackConfig,
  }) => {
    await fetchAndApplyPolicy({ api, tailnet, tailscaleSsh: true });
    await ensureTailnetHttpsEnabled({ api, tailnet });
    let status = null;
    if (getEnvVar(envVars, "ALPHACLAW_SETUP_URL")) {
      status = await readTailscaleStatus({ shellCmd, required: false });
    }
    if (!normalizeDnsName(status?.Self?.DNSName)) {
      const authKey = await createAuthKey({ api, tailnet });
      await runTailscaleCli(
        shellCmd,
        `tailscale up --auth-key=${shellQuote(authKey)} --hostname=${shellQuote(hostname)} --ssh`,
        { timeoutMs: 120000 },
      );
      status = await readTailscaleStatus({ shellCmd });
    }
    const dnsName = normalizeDnsName(status?.Self?.DNSName);
    if (!dnsName) {
      throw new Error("Tailscale DNS name missing; confirm MagicDNS is enabled");
    }

    await runTailscaleExposeWrapper(shellCmd, "configure-all");

    const deviceId = await resolveDeviceId({ status, api, tailnet, dnsName });
    if (!deviceId) throw new Error("Could not resolve joined Tailscale device ID");
    await api.request(`/device/${encodeURIComponent(deviceId)}/device-invites`, {
      method: "POST",
      body: [{ email: kCloudOpsEmail, multiUse: false, allowExitNode: false }],
    });

    const setupUrl = `https://${dnsName}`;
    const publicBaseUrl = `https://${dnsName}:${funnelPort}`;
    upsertEnvVar(envVars, "ALPHACLAW_SETUP_URL", setupUrl);
    upsertEnvVar(envVars, "ALPHACLAW_PUBLIC_BASE_URL", publicBaseUrl);
    writeEnvFile(envVars);
    reloadEnv();

    await callTeamYouWriteback({
      fetchImpl,
      setupUrl,
      publicBaseUrl,
      dnsName,
      writebackConfig,
    });

    return { setupUrl, publicBaseUrl, dnsName, deviceId, tailnet };
  };

  const finalizeGatewayTailscaleOnboarding = createGatewayTailscaleFinalizer({
    env,
    fetchImpl,
    writeEnvFile,
    reloadEnv,
    gatewayTailscaleClient,
    gatewayTailscaleClientFactory,
    fetchAndApplyPolicy,
    ensureTailnetHttpsEnabled,
    createAuthKey,
    resolveDeviceId,
    callTeamYouWriteback,
    cloudOpsEmail: kCloudOpsEmail,
    ensureAgentVaultService,
    buildAgentVaultServiceIdentity,
  });

  const finalizeTailscaleOnboarding = async ({ tailscaleApiToken }) => {
    const validation = getTailscaleApiTokenValidation(tailscaleApiToken);
    if (!validation.ok) {
      const error = new Error(validation.error);
      error.status = 400;
      throw error;
    }
    if (typeof shellCmd !== "function") {
      throw new Error("Tailscale setup requires shell command support");
    }
    const tailnet = String(env.TAILSCALE_TAILNET || kDefaultTailnet).trim() || kDefaultTailnet;
    const hostname =
      String(env.TAILSCALE_HOSTNAME || kDefaultHostname).trim() || kDefaultHostname;
    const envVars = typeof readEnvFile === "function" ? [...readEnvFile()] : [];
    const connectivityMode = getConnectivityMode({ env, envVars });
    const funnelPort = getPositivePort(
      getEnvValue(env, envVars, ["TAILSCALE_FUNNEL_PORT"]),
      kDefaultFunnelPort,
      "Tailscale Funnel port",
    );
    const writebackConfig = getTeamYouWritebackConfig({ envVars, env });
    const api = createTailscaleApiClient({
      token: validation.token,
      fetchImpl,
    });

    if (connectivityMode === kConnectivityModeSecurityGateway) {
      const servePort = getPositivePort(
        getEnvValue(env, envVars, ["TAILSCALE_SERVE_PORT"]),
        kDefaultServePort,
        "Tailscale Serve port",
      );
      if (servePort !== kDefaultServePort) {
        throw new Error(
          `Security gateway Tailscale Serve port must be ${kDefaultServePort}`,
        );
      }
      if (funnelPort !== kDefaultFunnelPort) {
        throw new Error(
          `Security gateway Tailscale Funnel port must be ${kDefaultFunnelPort}`,
        );
      }
      return finalizeGatewayTailscaleOnboarding({
        api,
        tailnet,
        hostname,
        servePort,
        funnelPort,
        envVars,
        writebackConfig,
      });
    }
    return finalizeLocalTailscaleOnboarding({
      api,
      tailnet,
      hostname,
      funnelPort,
      envVars,
      writebackConfig,
    });
  };

  return { finalizeTailscaleOnboarding };
};

module.exports = {
  kTailscaleTag,
  kCloudOpsEmail,
  kConnectivityModeLocal,
  kConnectivityModeSecurityGateway,
  getTailscaleApiTokenValidation,
  ensureAlphaclawTailscalePolicy,
  getConnectivityMode,
  parseGatewayStoredResult,
  createTailscaleApiClient,
  buildAgentVaultServiceIdentity,
  ensureAgentVaultService,
  createTailscaleFinalizer,
};
