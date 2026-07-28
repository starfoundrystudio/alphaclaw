const net = require("net");
const {
  buildTeamYouAgentVaultApprovalUrl,
  normalizeTeamYouAgentVaultEntryUrl,
} = require("../../agent-vault-links");
const {
  normalizeAgentVaultAccessRequest,
  planAgentVaultAccess,
} = require("../../agent-vault-access");

const kPluginId = "agent-vault";
const kMaxResponseBytes = 1024 * 1024;

const jsonToolResult = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

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
    // Keep the write side open until the server closes the connection. Calling
    // socket.end() here propagates a TCP half-close through the managed SSH
    // forward; the request reaches Agent Vault, but the forwarded response can
    // be replaced with an empty 200 before its JSON body is returned.
    socket.on("connect", () => socket.write(headers));
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
        if (!responseBody.length) {
          if (status < 200 || status >= 300) {
            throw new Error(`Agent Vault returned HTTP ${status}`);
          }
          throw new Error("Agent Vault returned an empty response");
        }
        let payload;
        try {
          payload = JSON.parse(responseBody.toString("utf8"));
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
  access,
  plan,
  { operatorUrl, entryUrl },
) => ({
  status: "proposal_created",
  service: {
    name: access.service.name,
    host: access.service.host,
  },
  credential_keys: access.referencedKeys,
  request_instructions: access.requestInstructions,
  proposed_changes: {
    service: !plan.serviceAvailable,
    credentials: plan.missingCredentialKeys,
  },
  proposal_id: Number(proposal?.id),
  approval_url: buildTeamYouAgentVaultApprovalUrl({
    approvalUrl: proposal?.approval_url,
    operatorUrl,
    entryUrl,
  }),
  instruction:
    "Return approval_url to the user. Do not ask the user to send credential values in chat. After approval, call ensure_service_access again, then follow request_instructions exactly.",
});

const createPlugin = () => ({
  id: kPluginId,
  name: "Agent Vault",
  description: "Service access and credential proposal broker for AlphaClaw",
  register(api) {
    api.registerTool(
      {
        name: "ensure_service_access",
        label: "Ensure Service Access",
        description:
          "Ensure Agent Vault has both a service rule and every credential it references. If anything is missing, create one atomic, value-less proposal and return the approval URL. Never ask for or accept credential values.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["service", "credentials", "reason"],
          properties: {
            service: {
              type: "object",
              additionalProperties: false,
              required: ["name", "host", "auth"],
              properties: {
                name: {
                  type: "string",
                  description:
                    "Canonical lowercase service slug, for example openweathermap.",
                },
                host: {
                  type: "string",
                  description:
                    "Exact host or Agent Vault host pattern, without a URL scheme.",
                },
                auth: {
                  type: "object",
                  additionalProperties: false,
                  required: ["type"],
                  properties: {
                    type: {
                      type: "string",
                      enum: ["bearer", "api-key", "basic", "passthrough"],
                    },
                    token: {
                      type: "string",
                      description: "Credential key for bearer authentication.",
                    },
                    key: {
                      type: "string",
                      description: "Credential key for API-key authentication.",
                    },
                    header: {
                      type: "string",
                      description: "Header used for API-key authentication.",
                    },
                    prefix: {
                      type: "string",
                      description: "Optional API-key header value prefix.",
                    },
                    username: {
                      type: "string",
                      description: "Credential key used as the Basic username.",
                    },
                    password: {
                      type: "string",
                      description: "Credential key used as the Basic password.",
                    },
                  },
                },
                substitutions: {
                  type: "array",
                  maxItems: 10,
                  description:
                    "Credential placeholders for path, query, header, body, or websocket injection. Omit placeholder to derive it deterministically from the key.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["key", "in"],
                    properties: {
                      key: { type: "string" },
                      placeholder: { type: "string" },
                      in: {
                        type: "array",
                        minItems: 1,
                        uniqueItems: true,
                        items: {
                          type: "string",
                          enum: [
                            "path",
                            "query",
                            "header",
                            "body",
                            "websocket",
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            credentials: {
              type: "array",
              maxItems: 10,
              description:
                "Value-less credential slots referenced by the service. Include metadata even when a key may already exist; existing keys are omitted from the proposal.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "description"],
                properties: {
                  key: { type: "string" },
                  description: { type: "string" },
                  obtain: { type: "string" },
                  obtainInstructions: { type: "string" },
                },
              },
            },
            reason: {
              type: "string",
              description: "Developer-facing reason service access is needed.",
            },
            userMessage: {
              type: "string",
              description:
                "Optional user-facing explanation shown on the approval page.",
            },
            requestInstructions: {
              type: "string",
              description:
                "How to construct the upstream request after approval, including parameter names for substitutions. Never include a credential value.",
            },
          },
        },
        async execute(_toolCallId, params) {
          try {
            const config = validateConfig();
            const access = normalizeAgentVaultAccessRequest(params);
            const discovered = await request({ pathname: "/discover" });
            const plan = planAgentVaultAccess(access, discovered);
            if (plan.status === "available") {
              return jsonToolResult({
                status: "available",
                service: plan.matchedService || {
                  name: access.service.name,
                  host: access.service.host,
                },
                credential_keys: access.referencedKeys,
                request_instructions: access.requestInstructions,
              });
            }
            const proposal = await request({
              pathname: "/v1/proposals",
              method: "POST",
              body: plan.proposal,
            });
            return jsonToolResult(
              proposalResult(proposal, access, plan, config),
            );
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
      { name: "ensure_service_access" },
    );
  },
});

const plugin = createPlugin();
module.exports = plugin;
module.exports.default = plugin;
