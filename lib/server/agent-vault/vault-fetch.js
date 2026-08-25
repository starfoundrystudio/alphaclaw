const fs = require("fs");
const http = require("http");
const tls = require("tls");
const {
  kAgentVaultCaPath,
  kAgentVaultProxyHost,
  kAgentVaultProxyPort,
  readAgentVaultRuntime,
} = require("./runtime-store");

const kConnectTimeoutMs = 10000;
const kRequestTimeoutMs = 15000;

// The alphaclaw server process is not behind proxyline (that wraps the
// OpenClaw gateway and its children), so its own channel probes with
// placeholder tokens would 401 if dialed directly. This helper tunnels a
// single HTTPS request through the Agent Vault proxy (CONNECT + TLS against
// the vault MITM CA) so substitution applies to alphaclaw's probes too.
// Returns a minimal fetch-compatible function, or null when the vault
// runtime is not claimed.

const connectThroughVaultProxy = ({ runtime, host, port }) =>
  new Promise((resolve, reject) => {
    const request = http.request({
      host: kAgentVaultProxyHost,
      port: kAgentVaultProxyPort,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        "Proxy-Authorization": `Basic ${Buffer.from(
          `${runtime.token}:${runtime.vault}`,
        ).toString("base64")}`,
      },
      timeout: kConnectTimeoutMs,
    });
    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(
        new Error(
          `Agent Vault proxy refused the tunnel (HTTP ${response.statusCode})`,
        ),
      );
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Agent Vault proxy CONNECT timed out"));
    });
    request.end();
  });

const createVaultAwareFetch = ({
  runtime = readAgentVaultRuntime(),
  caPath = kAgentVaultCaPath,
} = {}) => {
  if (!runtime) return null;
  let ca;
  try {
    ca = fs.readFileSync(caPath);
  } catch {
    return null;
  }
  return async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.protocol !== "https:") {
      throw new Error("Agent Vault brokered fetch supports https URLs only");
    }
    const port = Number(target.port || 443);
    const rawSocket = await connectThroughVaultProxy({
      runtime,
      host: target.hostname,
      port,
    });
    const tlsSocket = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { socket: rawSocket, servername: target.hostname, ca: [ca] },
        () => resolve(socket),
      );
      socket.on("error", reject);
    });
    try {
      return await new Promise((resolve, reject) => {
        // Plain http.request over the established TLS socket: the tunnel is
        // already encrypted; https.request would try to wrap TLS twice.
        const request = http.request(
          {
            createConnection: () => tlsSocket,
            host: target.hostname,
            path: `${target.pathname}${target.search}`,
            method: init.method || "GET",
            headers: { Host: target.host, ...(init.headers || {}) },
            timeout: kRequestTimeoutMs,
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              const status = Number(response.statusCode || 0);
              resolve({
                ok: status >= 200 && status < 300,
                status,
                headers: response.headers,
                text: async () => text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.on("timeout", () => {
          request.destroy(new Error("Agent Vault brokered request timed out"));
        });
        if (init.body != null) request.write(init.body);
        request.end();
      });
    } finally {
      tlsSocket.destroy();
    }
  };
};

module.exports = { createVaultAwareFetch };
