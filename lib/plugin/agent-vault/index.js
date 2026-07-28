const net = require("net");
const {
  buildTeamYouAgentVaultApprovalUrl,
  normalizeTeamYouAgentVaultEntryUrl,
} = require("../../agent-vault-links");

const kPluginId = "agent-vault";
const kCredentialKeyPattern = /^[A-Z][A-Z0-9_]{1,127}$/;
const kMaxResponseBytes = 1024 * 1024;

const jsonToolResult = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

const normalizeText = (value, maxLength, label) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || normalized.includes("\0")) {
    throw new Error(`${label} is missing or invalid`);
  }
  return normalized;
};

const validateConfig = () => {
  const address = String(process.env.AGENT_VAULT_ADDR || "").trim();
  const token = String(process.env.AGENT_VAULT_TOKEN || "").trim();
  const vault = String(process.env.AGENT_VAULT_VAULT || "").trim();
  const operatorUrl = String(
    process.env.AGENT_VAULT_OPERATOR_URL || "",
  ).trim();
  const entryUrl = normalizeTeamYouAgentVaultEntryUrl(
    process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL,
  );
  const parsed = new URL(address);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "14321" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Agent Vault is not connected through the managed tunnel");
  }
  if (!/^av_[A-Za-z0-9_-]{16,4096}$/.test(token) || !vault) {
    throw new Error("Agent Vault runtime identity is unavailable");
  }
  if (!entryUrl) {
    throw new Error("TeamYou Agent Vault entry URL is unavailable");
  }
  return {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || "80", 10),
    token,
    vault,
    operatorUrl,
    entryUrl,
  };
};

const decodeChunkedBody = (buffer) => {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) throw new Error("Agent Vault returned invalid chunked data");
    const sizeText = buffer
      .subarray(offset, lineEnd)
      .toString("ascii")
      .split(";", 1)[0];
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error("Agent Vault returned invalid chunked data");
    }
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size + 2 > buffer.length) {
      throw new Error("Agent Vault returned incomplete chunked data");
    }
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (buffer.subarray(offset, offset + 2).toString("ascii") !== "\r\n") {
      throw new Error("Agent Vault returned invalid chunked data");
    }
    offset += 2;
  }
  throw new Error("Agent Vault returned incomplete chunked data");
};

// OpenClaw intentionally routes ordinary loopback HTTP through its managed
// egress proxy. Agent Vault control-plane calls must not enter that proxy, so
// this client uses a bounded raw loopback socket instead of fetch/http.
const directLoopbackRequest = ({
  host,
  port,
  pathname,
  method,
  token,
  vault,
  body,
}) =>
  new Promise((resolve, reject) => {
    const serializedBody = body ? JSON.stringify(body) : "";
    const headers = [
      `${method} ${pathname} HTTP/1.1`,
      `Host: ${host}:${port}`,
      "Accept: application/json",
      `Authorization: Bearer ${token}`,
      `X-Vault: ${vault}`,
      "Connection: close",
      ...(serializedBody
        ? [
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(serializedBody, "utf8")}`,
          ]
        : []),
      "",
      serializedBody,
    ].join("\r\n");
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const socket = net.createConnection({ host, port });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10000, () =>
      fail(new Error("Agent Vault request timed out")),
    );
    socket.on("connect", () => socket.end(headers));
    socket.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > kMaxResponseBytes + 64 * 1024) {
        fail(new Error("Agent Vault returned too much data"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("error", (error) =>
      fail(new Error(`Agent Vault request failed: ${error.message}`)),
    );
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const response = Buffer.concat(chunks);
        const headerEnd = response.indexOf("\r\n\r\n");
        if (headerEnd < 0) throw new Error("Agent Vault returned invalid HTTP");
        const headerLines = response
          .subarray(0, headerEnd)
          .toString("latin1")
          .split("\r\n");
        const status = Number.parseInt(
          headerLines.shift()?.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || "",
          10,
        );
        if (!Number.isInteger(status)) {
          throw new Error("Agent Vault returned invalid HTTP");
        }
        const responseHeaders = new Map();
        for (const line of headerLines) {
          const colon = line.indexOf(":");
          if (colon <= 0) continue;
          responseHeaders.set(
            line.slice(0, colon).trim().toLowerCase(),
            line.slice(colon + 1).trim(),
          );
        }
        let responseBody = response.subarray(headerEnd + 4);
        if (
          responseHeaders.get("transfer-encoding")?.toLowerCase() ===
          "chunked"
        ) {
          responseBody = decodeChunkedBody(responseBody);
        }
        if (responseBody.length > kMaxResponseBytes) {
          throw new Error("Agent Vault returned too much data");
        }
        let payload;
        try {
          payload = responseBody.length
            ? JSON.parse(responseBody.toString("utf8"))
            : {};
        } catch {
          throw new Error("Agent Vault returned invalid JSON");
        }
        if (status < 200 || status >= 300) {
          throw new Error(
            String(payload?.error || `Agent Vault returned HTTP ${status}`),
          );
        }
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  });

const request = async ({ pathname, method = "GET", body }) => {
  const config = validateConfig();
  return directLoopbackRequest({
    ...config,
    pathname,
    method,
    body,
  });
};

const proposalResult = (
  proposal,
  key,
  { operatorUrl, entryUrl },
  status = "proposal_created",
) => ({
  status,
  key,
  proposal_id: Number(proposal?.id),
  approval_url: buildTeamYouAgentVaultApprovalUrl({
    approvalUrl: proposal?.approval_url,
    operatorUrl,
    entryUrl,
  }),
  instruction:
    "Return approval_url to the user. Do not ask the user to send the credential value in chat.",
});

const createPlugin = () => ({
  id: kPluginId,
  name: "Agent Vault",
  description: "Credential proposal broker for AlphaClaw",
  register(api) {
    api.registerTool(
      {
        name: "ensure_credential",
        label: "Ensure Credential",
        description:
          "Check whether a named credential exists in Agent Vault. If missing, create a value-less proposal and return the approval URL that must be shown to the user. Never ask for or accept the credential value.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["key", "description", "reason"],
          properties: {
            key: {
              type: "string",
              description:
                "Uppercase credential identifier, for example STRIPE_API_KEY.",
            },
            description: {
              type: "string",
              description: "What the credential is, without including its value.",
            },
            reason: {
              type: "string",
              description: "Why the agent needs this credential now.",
            },
          },
        },
        async execute(_toolCallId, params) {
          try {
            const config = validateConfig();
            const key = String(params?.key || "").trim().toUpperCase();
            if (!kCredentialKeyPattern.test(key)) {
              throw new Error(
                "Credential key must use uppercase letters, numbers, and underscores",
              );
            }
            const description = normalizeText(
              params?.description,
              500,
              "Credential description",
            );
            const reason = normalizeText(
              params?.reason,
              1000,
              "Credential reason",
            );
            const discovered = await request({ pathname: "/discover" });
            if (
              Array.isArray(discovered?.available_credentials) &&
              discovered.available_credentials.includes(key)
            ) {
              return jsonToolResult({ status: "available", key });
            }
            const proposal = await request({
              pathname: "/v1/proposals",
              method: "POST",
              body: {
                credentials: [{ action: "set", key, description }],
                message: reason,
                user_message: reason,
              },
            });
            return jsonToolResult(proposalResult(proposal, key, config));
          } catch (error) {
            return jsonToolResult(
              {
                status: "error",
                error: String(error?.message || "Agent Vault request failed"),
              },
              true,
            );
          }
        },
      },
      { name: "ensure_credential" },
    );
  },
});

const plugin = createPlugin();
module.exports = plugin;
module.exports.default = plugin;
