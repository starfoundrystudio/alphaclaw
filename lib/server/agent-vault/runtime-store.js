const fs = require("fs");
const path = require("path");
const { ALPHACLAW_DIR } = require("../constants");

const kAgentVaultDir = path.join(ALPHACLAW_DIR, "agent-vault");
const kAgentVaultRuntimePath = path.join(kAgentVaultDir, "runtime.json");
const kAgentVaultCaPath = path.join(kAgentVaultDir, "mitm-ca.pem");
const kAgentVaultApiAddress = "http://127.0.0.1:14321";
const kAgentVaultProxyHost = "127.0.0.1";
const kAgentVaultProxyPort = 14322;
const kDefaultVault = "default";
const kRuntimeModes = new Set(["brokered", "enforced"]);
const kAgentVaultTeamyouApiKeyPlaceholder =
  "__agent_vault_teamyou_api_key__";

const assertRegularPrivateFile = (filePath, existingStats = null) => {
  const stats = existingStats || fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Agent Vault runtime state is not a regular file");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Agent Vault runtime state permissions are too broad");
  }
};

const validateRuntime = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Vault runtime state is invalid");
  }
  const token = String(value.token || "").trim();
  const vault = String(value.vault || "").trim();
  const mode = String(value.mode || "").trim();
  const operatorUrl = String(value.operatorUrl || "").trim();
  if (!/^av_[A-Za-z0-9_-]{16,4096}$/.test(token)) {
    throw new Error("Agent Vault runtime token is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(vault)) {
    throw new Error("Agent Vault runtime vault is invalid");
  }
  if (!kRuntimeModes.has(mode)) {
    throw new Error("Agent Vault runtime mode is invalid");
  }
  let parsedOperatorUrl;
  try {
    parsedOperatorUrl = new URL(operatorUrl);
  } catch {
    throw new Error("Agent Vault operator URL is invalid");
  }
  if (
    parsedOperatorUrl.protocol !== "https:" ||
    parsedOperatorUrl.pathname !== "/" ||
    parsedOperatorUrl.search ||
    parsedOperatorUrl.hash ||
    !parsedOperatorUrl.hostname.endsWith(".ts.net")
  ) {
    throw new Error("Agent Vault operator URL is invalid");
  }
  return {
    version: 1,
    token,
    vault,
    mode,
    operatorUrl: parsedOperatorUrl.origin,
    createdAt: String(value.createdAt || ""),
    tokenAcknowledged: value.tokenAcknowledged === true,
    handoffComplete: value.handoffComplete === true,
  };
};

const readAgentVaultRuntime = () => {
  let stats;
  try {
    stats = fs.lstatSync(kAgentVaultRuntimePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  assertRegularPrivateFile(kAgentVaultRuntimePath, stats);
  return validateRuntime(
    JSON.parse(fs.readFileSync(kAgentVaultRuntimePath, "utf8")),
  );
};

const hasAgentVaultRuntime = () => {
  try {
    return fs.lstatSync(kAgentVaultRuntimePath).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const writePrivateFileAtomic = ({ filePath, content, mode }) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode });
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
};

const writeAgentVaultRuntime = ({
  token,
  vault = kDefaultVault,
  mode = "brokered",
  operatorUrl,
  createdAt = new Date().toISOString(),
  tokenAcknowledged = false,
  handoffComplete = false,
}) => {
  const runtime = validateRuntime({
    version: 1,
    token,
    vault,
    mode,
    operatorUrl,
    createdAt,
    tokenAcknowledged,
    handoffComplete,
  });
  writePrivateFileAtomic({
    filePath: kAgentVaultRuntimePath,
    content: `${JSON.stringify(runtime, null, 2)}\n`,
    mode: 0o600,
  });
  return runtime;
};

const markAgentVaultTokenAcknowledged = (
  runtime = readAgentVaultRuntime(),
) => {
  if (!runtime) {
    throw new Error("Agent Vault runtime state is unavailable");
  }
  return writeAgentVaultRuntime({
    ...runtime,
    tokenAcknowledged: true,
  });
};

const markAgentVaultHandoffComplete = (runtime = readAgentVaultRuntime()) => {
  if (!runtime) {
    throw new Error("Agent Vault runtime state is unavailable");
  }
  return writeAgentVaultRuntime({
    ...runtime,
    handoffComplete: true,
  });
};

const writeAgentVaultCa = (pem) => {
  const normalized = String(pem || "").trim();
  if (
    !normalized.startsWith("-----BEGIN CERTIFICATE-----") ||
    !normalized.endsWith("-----END CERTIFICATE-----")
  ) {
    throw new Error("Agent Vault CA response is invalid");
  }
  writePrivateFileAtomic({
    filePath: kAgentVaultCaPath,
    content: `${normalized}\n`,
    mode: 0o600,
  });
  return kAgentVaultCaPath;
};

const buildAgentVaultRuntimeEnv = (runtime = readAgentVaultRuntime()) => {
  if (!runtime) return {};
  if (!fs.existsSync(kAgentVaultCaPath)) {
    throw new Error("Agent Vault CA is missing");
  }
  assertRegularPrivateFile(kAgentVaultCaPath);
  const proxyUrl = new URL(
    `http://${kAgentVaultProxyHost}:${kAgentVaultProxyPort}`,
  );
  proxyUrl.username = runtime.token;
  proxyUrl.password = runtime.vault;
  const serializedProxyUrl = proxyUrl.toString();
  const noProxy = Array.from(
    new Set(
      [
        "localhost",
        "127.0.0.1",
        kAgentVaultProxyHost,
        ...String(process.env.NO_PROXY || "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ],
    ),
  ).join(",");
  return {
    AGENT_VAULT_ADDR: kAgentVaultApiAddress,
    AGENT_VAULT_TOKEN: runtime.token,
    AGENT_VAULT_VAULT: runtime.vault,
    AGENT_VAULT_OPERATOR_URL: runtime.operatorUrl,
    // TeamYou's existing OpenClaw integrations require a configured API-key
    // value before issuing a request. Agent Vault replaces this non-secret
    // bearer placeholder with the brokered credential at the proxy.
    TEAMYOU_API_KEY: kAgentVaultTeamyouApiKeyPlaceholder,
    HTTPS_PROXY: serializedProxyUrl,
    HTTP_PROXY: serializedProxyUrl,
    NO_PROXY: noProxy,
    NODE_USE_ENV_PROXY: "1",
    OPENCLAW_PROXY_URL: serializedProxyUrl,
    SSL_CERT_FILE: kAgentVaultCaPath,
    NODE_EXTRA_CA_CERTS: kAgentVaultCaPath,
    REQUESTS_CA_BUNDLE: kAgentVaultCaPath,
    CURL_CA_BUNDLE: kAgentVaultCaPath,
    GIT_SSL_CAINFO: kAgentVaultCaPath,
    DENO_CERT: kAgentVaultCaPath,
  };
};

module.exports = {
  kAgentVaultApiAddress,
  kAgentVaultCaPath,
  kAgentVaultRuntimePath,
  kAgentVaultTeamyouApiKeyPlaceholder,
  buildAgentVaultRuntimeEnv,
  hasAgentVaultRuntime,
  markAgentVaultHandoffComplete,
  markAgentVaultTokenAcknowledged,
  readAgentVaultRuntime,
  writeAgentVaultCa,
  writeAgentVaultRuntime,
};
