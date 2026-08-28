const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const {
  CLAUDE_BROKER_CLIENT_ID,
  CLAUDE_BROKER_CONSUMER,
  CLAUDE_BROKER_PROVIDER,
  CLAUDE_BROKER_REQUIRED_SCOPE,
  CODEX_BROKER_CONSUMER,
  CODEX_BROKER_PROVIDER,
  GOG_BROKER_PROVIDER,
  isGogBrokerConsumer,
} = require("../oauth-broker-constants");
const { ALPHACLAW_DIR } = require("./constants");

const kSchemaVersion = 1;
const kDefaultTimeoutMs = 45 * 1000;
const kMaxStdoutBytes = 64 * 1024;
const kMaxStderrBytes = 16 * 1024;
const kDnsNamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

class OAuthBrokerError extends Error {
  constructor(code, message = "OAuth credential broker request failed") {
    super(message);
    this.name = "OAuthBrokerError";
    this.code = code;
  }
}

const validateHost = (value) => {
  const host = String(value || "")
    .trim()
    .toLowerCase();
  if (!host || /[\r\n\0]/.test(host)) {
    throw new OAuthBrokerError(
      "invalid_config",
      "OAuth credential broker configuration is invalid",
    );
  }
  if (!net.isIP(host) && !kDnsNamePattern.test(host)) {
    throw new OAuthBrokerError(
      "invalid_config",
      "OAuth credential broker configuration is invalid",
    );
  }
  return host;
};

const validateCredentialFile = ({ fsModule, filePath, privateFile }) => {
  let stats;
  try {
    stats = fsModule.lstatSync(filePath);
  } catch {
    throw new OAuthBrokerError(
      "not_configured",
      "OAuth credential broker is not configured",
    );
  }
  if (!stats.isFile() || (stats.mode & (privateFile ? 0o077 : 0o022)) !== 0) {
    throw new OAuthBrokerError(
      "invalid_config",
      "OAuth credential broker files are invalid",
    );
  }
};

const buildSshArgs = ({ host, identityFile, knownHostsFile }) => [
  "-T",
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
  `root@${host}`,
];

const runSshJsonRequest = ({
  spawnImpl = spawn,
  args,
  payload,
  timeoutMs = kDefaultTimeoutMs,
}) =>
  new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    try {
      child = spawnImpl("/usr/bin/ssh", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
        },
      });
    } catch {
      finish(new OAuthBrokerError("ssh_start_failed"));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.on("error", () => finish(new OAuthBrokerError("ssh_start_failed")));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > kMaxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new OAuthBrokerError("response_too_large"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > kMaxStderrBytes) {
        child.kill("SIGKILL");
        finish(new OAuthBrokerError("error_output_too_large"));
      }
    });
    child.stdin.on("error", () =>
      finish(new OAuthBrokerError("request_send_failed")),
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish(
          new OAuthBrokerError("timeout", "OAuth credential broker timed out"),
        );
        return;
      }
      let response;
      try {
        response = JSON.parse(stdout);
      } catch {
        finish(
          new OAuthBrokerError(code === 0 ? "invalid_response" : "ssh_failed"),
        );
        return;
      }
      if (response?.ok === false && typeof response.error === "string") {
        finish(new OAuthBrokerError(response.error));
        return;
      }
      if (code !== 0) {
        finish(new OAuthBrokerError("ssh_failed"));
        return;
      }
      finish(null, response);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });

const validateBaseResponse = (response, operation) => {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.schema_version !== kSchemaVersion ||
    response.operation !== operation ||
    response.ok !== true
  ) {
    throw new OAuthBrokerError("invalid_response");
  }
  return response;
};

const validateAccessTokenResponse = (response) => {
  if (
    typeof response.access_token !== "string" ||
    !response.access_token ||
    !Number.isInteger(response.expires_at) ||
    response.expires_at <= 0 ||
    !Array.isArray(response.scopes) ||
    typeof response.scopes_known !== "boolean"
  ) {
    throw new OAuthBrokerError("invalid_response");
  }
  return response;
};

const validateRevokeResponse = (response) => {
  if (
    response.revoked !== true ||
    typeof response.provider_revocation !== "string"
  ) {
    throw new OAuthBrokerError("invalid_response");
  }
  return response;
};

const validateGogConsumer = (consumer) => {
  const normalized = String(consumer || "");
  if (!isGogBrokerConsumer(normalized)) {
    throw new OAuthBrokerError(
      "invalid_consumer",
      "Google OAuth broker account slot is invalid",
    );
  }
  return normalized;
};

const createOAuthBrokerClient = ({
  fsModule = fs,
  spawnImpl = spawn,
  brokerDir = path.join(ALPHACLAW_DIR, "oauth-broker"),
  timeoutMs = kDefaultTimeoutMs,
  requestImpl,
} = {}) => {
  const configPath = path.join(brokerDir, "config.json");
  const identityFile = path.join(brokerDir, "id_ed25519");
  const knownHostsFile = path.join(brokerDir, "known_hosts");

  const isConfigured = () =>
    [configPath, identityFile, knownHostsFile].every((filePath) => {
      try {
        return fsModule.lstatSync(filePath).isFile();
      } catch {
        return false;
      }
    });

  const resolveConnection = () => {
    validateCredentialFile({
      fsModule,
      filePath: identityFile,
      privateFile: true,
    });
    validateCredentialFile({
      fsModule,
      filePath: knownHostsFile,
      privateFile: false,
    });
    let config;
    try {
      config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    } catch {
      throw new OAuthBrokerError(
        "invalid_config",
        "OAuth credential broker configuration is invalid",
      );
    }
    if (config?.schema_version !== kSchemaVersion) {
      throw new OAuthBrokerError(
        "invalid_config",
        "OAuth credential broker configuration is invalid",
      );
    }
    return {
      host: validateHost(config.gateway_host),
      identityFile,
      knownHostsFile,
    };
  };

  const request = async (operation, fields = {}) => {
    const payload = { schema_version: kSchemaVersion, operation, ...fields };
    const response = requestImpl
      ? await requestImpl(payload)
      : await runSshJsonRequest({
          spawnImpl,
          args: buildSshArgs(resolveConnection()),
          payload,
          timeoutMs,
        });
    return validateBaseResponse(response, operation);
  };

  return {
    isConfigured,
    status: async () => {
      const response = await request("status");
      if (
        !Array.isArray(response.grants) ||
        typeof response.denied !== "boolean"
      ) {
        throw new OAuthBrokerError("invalid_response");
      }
      return response;
    },
    depositCodexGrant: async ({ clientId, refreshToken, scopes }) => {
      await request("deposit", {
        consumer: CODEX_BROKER_CONSUMER,
        provider: CODEX_BROKER_PROVIDER,
        grant: {
          client_id: clientId,
          refresh_token: refreshToken,
          scopes,
        },
      });
      return true;
    },
    getCodexAccessToken: async ({ scopes }) => {
      const response = await request("access_token", {
        consumer: CODEX_BROKER_CONSUMER,
        provider: CODEX_BROKER_PROVIDER,
        scopes,
      });
      return validateAccessTokenResponse(response);
    },
    revokeCodexGrant: async () => {
      const response = await request("revoke", {
        consumer: CODEX_BROKER_CONSUMER,
        provider: CODEX_BROKER_PROVIDER,
      });
      return validateRevokeResponse(response);
    },
    depositClaudeGrant: async ({ refreshToken }) => {
      await request("deposit", {
        consumer: CLAUDE_BROKER_CONSUMER,
        provider: CLAUDE_BROKER_PROVIDER,
        grant: {
          client_id: CLAUDE_BROKER_CLIENT_ID,
          refresh_token: refreshToken,
          scopes: [CLAUDE_BROKER_REQUIRED_SCOPE],
          extra_params: { expires_in: "3600" },
        },
      });
      return true;
    },
    getClaudeAccessToken: async () => {
      const response = await request("access_token", {
        consumer: CLAUDE_BROKER_CONSUMER,
        provider: CLAUDE_BROKER_PROVIDER,
      });
      return validateAccessTokenResponse(response);
    },
    revokeClaudeGrant: async () => {
      const response = await request("revoke", {
        consumer: CLAUDE_BROKER_CONSUMER,
        provider: CLAUDE_BROKER_PROVIDER,
      });
      return validateRevokeResponse(response);
    },
    depositGogGrant: async ({
      consumer,
      clientId,
      clientSecret,
      refreshToken,
      scopes,
    }) => {
      await request("deposit", {
        consumer: validateGogConsumer(consumer),
        provider: GOG_BROKER_PROVIDER,
        grant: {
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          scopes,
        },
      });
      return true;
    },
    getGogAccessToken: async ({ consumer }) => {
      const response = await request("access_token", {
        consumer: validateGogConsumer(consumer),
        provider: GOG_BROKER_PROVIDER,
      });
      return validateAccessTokenResponse(response);
    },
    revokeGogGrant: async ({ consumer }) => {
      const response = await request("revoke", {
        consumer: validateGogConsumer(consumer),
        provider: GOG_BROKER_PROVIDER,
      });
      return validateRevokeResponse(response);
    },
  };
};

module.exports = {
  OAuthBrokerError,
  buildSshArgs,
  createOAuthBrokerClient,
  runSshJsonRequest,
};
