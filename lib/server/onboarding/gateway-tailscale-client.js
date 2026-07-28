const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const kGatewaySetupSchemaVersion = 1;
const kDefaultSshPort = 22;
const kDefaultSshUser = "root";
const kDefaultTimeoutMs = 120000;
const kMaxStdoutBytes = 64 * 1024;
const kMaxStderrBytes = 16 * 1024;
const kDnsNamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// The clawctl-installed forced command accepts exactly one JSON request on
// stdin and emits exactly one JSON response on stdout. Secrets never enter the
// SSH argv, process environment, logs, or response payload. Sealing is a
// durable, idempotent state transition: the forced command must continue to
// permit status/seal with this identity after sealing while rejecting configure.
// AlphaClaw removes the private identity after it durably records confirmation.
const requireSingleLine = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return normalized;
};

const validateHost = (value) => {
  const host = requireSingleLine(value, "Gateway setup host");
  if (net.isIP(host)) return host;
  if (!kDnsNamePattern.test(host.toLowerCase())) {
    throw new Error("Gateway setup host is invalid");
  }
  return host.toLowerCase();
};

const validatePort = (value) => {
  const rawValue =
    value === undefined || value === null || value === ""
      ? kDefaultSshPort
      : value;
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Gateway setup SSH port is invalid");
  }
  return port;
};

const validateUser = (value) => {
  const user = String(value || kDefaultSshUser).trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
    throw new Error("Gateway setup SSH user is invalid");
  }
  return user;
};

const validateAbsolutePath = (value, label) => {
  const normalized = requireSingleLine(value, label);
  if (!path.isAbsolute(normalized)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return normalized;
};

const validateCredentialFile = ({ fsImpl, filePath, label, privateFile }) => {
  let stats;
  try {
    stats = fsImpl.lstatSync(filePath);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  const disallowedMode = privateFile ? 0o077 : 0o022;
  if ((stats.mode & disallowedMode) !== 0) {
    throw new Error(`${label} permissions are too broad`);
  }
};

const buildSshArgs = ({
  host,
  port,
  user,
  identityFile,
  knownHostsFile,
}) => [
  "-T",
  "-p",
  String(port),
  "-i",
  identityFile,
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${knownHostsFile}`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ConnectionAttempts=1",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "RequestTTY=no",
  "-o",
  "LogLevel=ERROR",
  `${user}@${host}`,
];

const runSshJsonRequest = ({
  spawnImpl,
  args,
  payload,
  timeoutMs = kDefaultTimeoutMs,
}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let timedOut = false;
    let child;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    try {
      child = spawnImpl("ssh", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
        },
      });
    } catch {
      reject(new Error("Gateway setup SSH could not be started"));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.on("error", () => {
      finish(new Error("Gateway setup SSH could not be started"));
    });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > kMaxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error("Gateway setup returned too much output"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > kMaxStderrBytes) {
        child.kill("SIGKILL");
        finish(new Error("Gateway setup returned too much error output"));
      }
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(new Error("Gateway setup timed out"));
        return;
      }
      if (code !== 0) {
        finish(new Error("Gateway setup command failed"));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error("Gateway setup returned invalid JSON"));
      }
    });

    child.stdin.on("error", () => {
      finish(new Error("Gateway setup request could not be sent"));
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });

const validateBaseResponse = (response, operation) => {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Gateway setup returned an invalid response");
  }
  if (response.schema_version !== kGatewaySetupSchemaVersion) {
    throw new Error("Gateway setup schema version is incompatible");
  }
  if (response.operation !== operation || response.ok !== true) {
    throw new Error(`Gateway setup ${operation} did not succeed`);
  }
  return response;
};

const normalizeGatewayStatus = (response, operation) => {
  const parsed = validateBaseResponse(response, operation);
  const configured = parsed.configured === true;
  if (!configured) {
    return {
      configured: false,
      sealed: parsed.sealed === true,
    };
  }

  const dnsName = requireSingleLine(
    parsed.tailscale_dns,
    "Gateway Tailscale DNS name",
  )
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!dnsName.endsWith(".ts.net") || !kDnsNamePattern.test(dnsName)) {
    throw new Error("Gateway Tailscale DNS name is invalid");
  }
  const deviceId = requireSingleLine(
    parsed.tailscale_device_id,
    "Gateway Tailscale device ID",
  );
  if (deviceId.length > 512) {
    throw new Error("Gateway Tailscale device ID is invalid");
  }
  const agentVaultOperatorUrl = requireSingleLine(
    parsed.agent_vault_operator_url,
    "Agent Vault operator URL",
  );
  let parsedAgentVaultUrl;
  try {
    parsedAgentVaultUrl = new URL(agentVaultOperatorUrl);
  } catch {
    throw new Error("Agent Vault operator URL is invalid");
  }
  if (
    parsedAgentVaultUrl.protocol !== "https:" ||
    parsedAgentVaultUrl.pathname !== "/" ||
    parsedAgentVaultUrl.search ||
    parsedAgentVaultUrl.hash ||
    !parsedAgentVaultUrl.hostname.endsWith(".ts.net")
  ) {
    throw new Error("Agent Vault operator URL is invalid");
  }

  return {
    configured: true,
    sealed: parsed.sealed === true,
    dnsName,
    deviceId,
    tailnet: String(parsed.tailnet || "").trim(),
    agentVaultOperatorUrl: parsedAgentVaultUrl.origin,
  };
};

const createGatewayTailscaleClient = ({
  host,
  port = kDefaultSshPort,
  user = kDefaultSshUser,
  identityFile,
  knownHostsFile,
  fsImpl = fs,
  spawnImpl = spawn,
  timeoutMs = kDefaultTimeoutMs,
} = {}) => {
  const normalizedHost = validateHost(host);
  const normalizedPort = validatePort(port);
  const normalizedUser = validateUser(user);
  const normalizedIdentityFile = validateAbsolutePath(
    identityFile,
    "Gateway setup identity file",
  );
  const normalizedKnownHostsFile = validateAbsolutePath(
    knownHostsFile,
    "Gateway setup known-hosts file",
  );

  const request = async (operation, extra = {}) => {
    validateCredentialFile({
      fsImpl,
      filePath: normalizedIdentityFile,
      label: "Gateway setup identity file",
      privateFile: true,
    });
    validateCredentialFile({
      fsImpl,
      filePath: normalizedKnownHostsFile,
      label: "Gateway setup known-hosts file",
      privateFile: false,
    });
    const response = await runSshJsonRequest({
      spawnImpl,
      args: buildSshArgs({
        host: normalizedHost,
        port: normalizedPort,
        user: normalizedUser,
        identityFile: normalizedIdentityFile,
        knownHostsFile: normalizedKnownHostsFile,
      }),
      payload: {
        schema_version: kGatewaySetupSchemaVersion,
        operation,
        ...extra,
      },
      timeoutMs,
    });
    return validateBaseResponse(response, operation);
  };

  return {
    status: async () =>
      normalizeGatewayStatus(await request("status"), "status"),
    configure: ({
      authKey,
      hostname,
      servePort,
      funnelPort,
      enableSshBridge = true,
      agentVaultServiceName,
    }) =>
      request("configure", {
        auth_key: requireSingleLine(authKey, "Tailscale auth key"),
        hostname: requireSingleLine(hostname, "Tailscale hostname"),
        serve_port: validatePort(servePort),
        funnel_port: validatePort(funnelPort),
        enable_ssh_bridge: enableSshBridge === true,
        agent_vault_service_name: requireSingleLine(
          agentVaultServiceName,
          "Agent Vault Tailscale Service name",
        ),
      }).then((response) => normalizeGatewayStatus(response, "configure")),
    seal: async () => {
      const result = normalizeGatewayStatus(
        await request("seal"),
        "seal",
      );
      if (!result.sealed) {
        throw new Error("Gateway setup seal was not confirmed");
      }
      return result;
    },
    claimAgentVaultRuntimeToken: async () => {
      const response = await request("agent_vault_runtime_token");
      if (response.runtime_token_ready !== true) {
        return { ready: false };
      }
      const token = requireSingleLine(
        response.runtime_token,
        "Agent Vault runtime token",
      );
      if (!/^av_[A-Za-z0-9_-]{16,4096}$/.test(token)) {
        throw new Error("Agent Vault runtime token is invalid");
      }
      return { ready: true, token };
    },
    acknowledgeAgentVaultRuntimeToken: async ({ tokenSha256 }) => {
      const normalizedHash = requireSingleLine(
        tokenSha256,
        "Agent Vault runtime token hash",
      ).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
        throw new Error("Agent Vault runtime token hash is invalid");
      }
      const response = await request("agent_vault_runtime_token_ack", {
        token_sha256: normalizedHash,
      });
      if (response.acknowledged !== true) {
        throw new Error("Agent Vault runtime token acknowledgement failed");
      }
      return { acknowledged: true };
    },
    cleanupIdentity: () => {
      try {
        fsImpl.rmSync(normalizedIdentityFile, { force: true });
      } catch {
        throw new Error("Gateway setup identity cleanup failed");
      }
    },
  };
};

module.exports = {
  kGatewaySetupSchemaVersion,
  buildSshArgs,
  createGatewayTailscaleClient,
  normalizeGatewayStatus,
};
