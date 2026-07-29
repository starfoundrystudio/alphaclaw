const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const kCaPem = [
  "-----BEGIN CERTIFICATE-----",
  "dGVzdA==",
  "-----END CERTIFICATE-----",
].join("\n");

describe("server/agent-vault", () => {
  let rootDir;
  let previousRootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-agent-vault-"));
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
    process.env.ALPHACLAW_ROOT_DIR = rootDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousRootDir === undefined) {
      delete process.env.ALPHACLAW_ROOT_DIR;
    } else {
      process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores the proxy identity privately and builds the canonical broker env", () => {
    const {
      buildAgentVaultRuntimeEnv,
      kAgentVaultCaPath,
      kAgentVaultRuntimePath,
      writeAgentVaultCa,
      writeAgentVaultRuntime,
    } = require("../../lib/server/agent-vault/runtime-store");

    writeAgentVaultCa(kCaPem);
    writeAgentVaultRuntime({
      token: "av_runtime_token_123456789",
      vault: "default",
      mode: "brokered",
      operatorUrl: "https://agent-vault-test.tail123.ts.net",
      handoffComplete: true,
    });
    const env = buildAgentVaultRuntimeEnv();
    const proxy = new URL(env.HTTPS_PROXY);

    expect(proxy.protocol).toBe("http:");
    expect(proxy.hostname).toBe("127.0.0.1");
    expect(proxy.port).toBe("14322");
    expect(proxy.username).toBe("av_runtime_token_123456789");
    expect(proxy.password).toBe("default");
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.OPENCLAW_PROXY_URL).toBe(env.HTTPS_PROXY);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(kAgentVaultCaPath);
    expect(env.AGENT_VAULT_OPERATOR_URL).toBe(
      "https://agent-vault-test.tail123.ts.net",
    );
    expect(env.TEAMYOU_API_KEY).toBe("__agent_vault_teamyou_api_key__");
    expect(fs.statSync(kAgentVaultRuntimePath).mode & 0o077).toBe(0);
    expect(fs.statSync(kAgentVaultCaPath).mode & 0o077).toBe(0);
  });

  it("claims, persists, enables, and acknowledges the runtime identity", async () => {
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { mode: "local" } }),
    );
    const gatewayClient = {
      claimAgentVaultRuntimeToken: vi.fn(async () => ({
        ready: true,
        token: "av_runtime_token_123456789",
      })),
      acknowledgeAgentVaultRuntimeToken: vi.fn(async () => ({
        acknowledged: true,
      })),
      cleanupIdentity: vi.fn(),
    };
    const requests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/v1/mitm/ca.pem")) {
        return new Response(kCaPem, {
          status: 200,
          headers: { "X-MITM-Port": "14322" },
        });
      }
      if (String(url).endsWith("/discover")) {
        return Response.json({
          vault: "default",
          services: [],
          available_credentials: [
            "STRIPE_API_KEY",
            {
              key: "OPENAI_API_KEY",
              type: "static",
              created_at: "2026-07-20T12:30:00Z",
              updated_at: "2026-07-21T14:45:00Z",
            },
          ],
        });
      }
      if (String(url).endsWith("/v1/proposals/7")) {
        return Response.json({
          id: 7,
          status: "pending",
          services: [
            {
              action: "set",
              name: "github",
              host: "api.github.com",
              auth: { type: "bearer", token: "GITHUB_TOKEN" },
            },
          ],
          credentials: [
            {
              action: "set",
              key: "GITHUB_TOKEN",
              description: "GitHub API token",
            },
          ],
          message: "Publish the requested release",
          created_at: "2026-07-27T20:15:00Z",
        });
      }
      if (String(url).endsWith("/v1/proposals")) {
        return Response.json(
          {
            id: 7,
            status: "pending",
            vault: "default",
            approval_url:
              "https://agent-vault-test.tail123.ts.net/approve/7?token=once",
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const envVars = [
      { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
      {
        key: "AGENT_VAULT_OPERATOR_URL",
        value: "https://agent-vault-test.tail123.ts.net",
      },
      {
        key: "TEAMYOU_AGENT_VAULT_ENTRY_URL",
        value:
          "https://www.teamyou.com/openclaw/agent-vault/inst_test123",
      },
      { key: "ALPHACLAW_GATEWAY_SETUP_HOST", value: "10.0.0.2" },
      { key: "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE", value: "/private/key" },
      {
        key: "ALPHACLAW_GATEWAY_SETUP_KNOWN_HOSTS_FILE",
        value: "/private/known-hosts",
      },
    ];
    const { createAgentVaultService } = require(
      "../../lib/server/agent-vault/service"
    );
    const onRuntimeRestartRequired = vi.fn(async () => {});
    const service = createAgentVaultService({
      env: {},
      readEnvFile: () => envVars,
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      openclawDir,
      fetchImpl,
      gatewayTailscaleClientFactory: () => gatewayClient,
      onRuntimeRestartRequired,
    });

    await expect(service.claimRuntimeToken()).resolves.toMatchObject({
      ready: true,
      claimed: true,
      restartRequired: false,
      restarted: true,
    });
    expect(onRuntimeRestartRequired).toHaveBeenCalledOnce();
    expect(gatewayClient.acknowledgeAgentVaultRuntimeToken).toHaveBeenCalledWith({
      tokenSha256:
        "6911998848aa2dcce7f20c89d81d63b6233537aad4997d0ae0e188d9861dfb35",
    });
    expect(gatewayClient.cleanupIdentity).toHaveBeenCalledOnce();
    const { readAgentVaultRuntime } = require(
      "../../lib/server/agent-vault/runtime-store"
    );
    expect(readAgentVaultRuntime()).toMatchObject({
      tokenAcknowledged: true,
      handoffComplete: true,
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      ).proxy.enabled,
    ).toBe(true);

    await expect(service.listCredentials()).resolves.toEqual({
      vault: "default",
      credentials: ["OPENAI_API_KEY", "STRIPE_API_KEY"],
      credentialDetails: [
        {
          key: "OPENAI_API_KEY",
          vault: "default",
          status: "available",
          type: "static",
          createdAt: "2026-07-20T12:30:00.000Z",
          updatedAt: "2026-07-21T14:45:00.000Z",
        },
        {
          key: "STRIPE_API_KEY",
          vault: "default",
          status: "available",
          type: "",
          createdAt: "",
          updatedAt: "",
        },
      ],
      services: [],
    });

    await expect(
      service.ensureServiceAccess({
        service: {
          name: "github",
          host: "api.github.com",
          auth: { type: "bearer", token: "GITHUB_TOKEN" },
        },
        credentials: [
          {
            key: "github_token",
            description: "GitHub API token",
          },
        ],
        reason: "Publish the requested release",
      }),
    ).resolves.toMatchObject({
      status: "proposal_created",
      service: {
        name: "github",
        host: "api.github.com",
      },
      credentialKeys: ["GITHUB_TOKEN"],
      proposal: {
        id: 7,
        approvalUrl:
          "https://www.teamyou.com/openclaw/agent-vault/inst_test123?return_to=%2Fapprove%2F7%3Ftoken%3Donce",
        service: {
          name: "github",
          host: "api.github.com",
          authType: "bearer",
        },
        credentialKeys: ["GITHUB_TOKEN"],
        key: "GITHUB_TOKEN",
        description: "GitHub API token",
        reason: "Publish the requested release",
      },
    });
    const proposalRequest = requests.find(({ url }) =>
      url.endsWith("/v1/proposals"),
    );
    const proposalBody = JSON.parse(proposalRequest.options.body);
    expect(proposalBody.services).toEqual([
      {
        action: "set",
        name: "github",
        host: "api.github.com",
        auth: { type: "bearer", token: "GITHUB_TOKEN" },
      },
    ]);
    expect(proposalBody.credentials).toEqual([
      {
        action: "set",
        key: "GITHUB_TOKEN",
        type: "static",
        description: "GitHub API token",
      },
    ]);
    expect(proposalBody.credentials[0]).not.toHaveProperty("value");

    await expect(service.getProposal(7)).resolves.toMatchObject({
      id: 7,
      status: "pending",
      service: {
        name: "github",
        host: "api.github.com",
        authType: "bearer",
      },
      key: "GITHUB_TOKEN",
      description: "GitHub API token",
      reason: "Publish the requested release",
      createdAt: "2026-07-27T20:15:00.000Z",
    });
  });

  it("plans only the missing pieces of an atomic service access request", () => {
    const {
      normalizeAgentVaultAccessRequest,
      planAgentVaultAccess,
    } = require("../../lib/agent-vault-access");
    const access = normalizeAgentVaultAccessRequest({
      service: {
        name: "openweathermap",
        host: "api.openweathermap.org",
        auth: { type: "passthrough" },
        substitutions: [
          {
            key: "OPENWEATHER_API_KEY",
            in: ["query"],
          },
        ],
      },
      credentials: [
        {
          key: "OPENWEATHER_API_KEY",
          description: "OpenWeather API key",
        },
      ],
      reason: "Fetch current weather",
      requestInstructions:
        "Set the appid query parameter to __openweather_api_key__.",
    });

    expect(access.service.substitutions).toEqual([
      {
        key: "OPENWEATHER_API_KEY",
        placeholder: "__openweather_api_key__",
        in: ["query"],
      },
    ]);
    expect(
      planAgentVaultAccess(access, {
        services: [],
        available_credentials: ["OPENWEATHER_API_KEY"],
      }),
    ).toMatchObject({
      status: "proposal_required",
      serviceAvailable: false,
      missingCredentialKeys: [],
      proposal: {
        services: [
          {
            action: "set",
            name: "openweathermap",
            host: "api.openweathermap.org",
          },
        ],
        credentials: [],
      },
    });
    expect(
      planAgentVaultAccess(access, {
        services: [
          {
            name: "openweathermap",
            host: "api.openweathermap.org",
          },
        ],
        available_credentials: ["OPENWEATHER_API_KEY"],
      }),
    ).toMatchObject({
      status: "available",
      serviceAvailable: true,
      missingCredentialKeys: [],
    });
  });

  it("rejects secret values and incomplete service credential references", () => {
    const { containsCredentialValue } = require(
      "../../lib/server/routes/agent-vault"
    );
    const {
      normalizeAgentVaultAccessRequest,
      planAgentVaultAccess,
    } = require("../../lib/agent-vault-access");

    expect(
      containsCredentialValue({
        credentials: [
          {
            key: "EXAMPLE_API_KEY",
            value: "must-not-enter-alpha-claw",
          },
        ],
      }),
    ).toBe(true);
    expect(
      containsCredentialValue({
        service: {
          auth: { type: "bearer", token: "EXAMPLE_API_KEY" },
        },
      }),
    ).toBe(false);
    expect(() =>
      normalizeAgentVaultAccessRequest({
        service: {
          name: "example--api",
          host: "api.example.com",
          auth: { type: "passthrough" },
        },
        credentials: [],
        reason: "Call the example API",
      }),
    ).toThrow("Service name must be a 3-64 character lowercase slug");

    const access = normalizeAgentVaultAccessRequest({
      service: {
        name: "example-api",
        host: "api.example.com",
        auth: { type: "bearer", token: "EXAMPLE_API_KEY" },
      },
      credentials: [],
      reason: "Call the example API",
    });
    expect(() =>
      planAgentVaultAccess(access, {
        services: [],
        available_credentials: [],
      }),
    ).toThrow(
      "Credential EXAMPLE_API_KEY is not available and needs a credential slot",
    );
  });

  it("keeps plugin control-plane calls off the managed HTTP proxy", async () => {
    const previousEnv = {
      address: process.env.AGENT_VAULT_ADDR,
      token: process.env.AGENT_VAULT_TOKEN,
      vault: process.env.AGENT_VAULT_VAULT,
      operatorUrl: process.env.AGENT_VAULT_OPERATOR_URL,
      entryUrl: process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL,
    };
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          url: req.url,
          authorization: req.headers.authorization,
          vault: req.headers["x-vault"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        let responded = false;
        const respondToHalfClose = () => {
          if (responded) return;
          responded = true;
          res.writeHead(200, {
            "Content-Length": "0",
            Connection: "close",
          });
          res.end();
        };
        req.socket.once("end", respondToHalfClose);

        // Model the SSH forward used in production: a client-side half-close
        // can terminate the forwarded response before Agent Vault's JSON body
        // reaches the plugin.
        setTimeout(() => {
          if (responded) return;
          responded = true;
          req.socket.off("end", respondToHalfClose);
          res.setHeader("Content-Type", "application/json");
          if (req.url === "/v1/proposals") {
            res.statusCode = 201;
            res.end(
              JSON.stringify({
                id: 12,
                status: "pending",
                approval_url:
                  "https://agent-vault-test.tail123.ts.net/approve/12?token=once",
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({
              vault: "default",
              services: [
                {
                  name: "github",
                  host: "api.github.com",
                },
              ],
              available_credentials: [{ key: "GITHUB_TOKEN", type: "static" }],
            }),
          );
        }, 10);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(14321, "127.0.0.1", resolve);
    });
    try {
      process.env.AGENT_VAULT_ADDR = "http://127.0.0.1:14321";
      process.env.AGENT_VAULT_TOKEN = "av_agt_runtime_token_123456789";
      process.env.AGENT_VAULT_VAULT = "default";
      process.env.AGENT_VAULT_OPERATOR_URL =
        "https://agent-vault-test.tail123.ts.net";
      process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL =
        "https://www.teamyou.com/openclaw/agent-vault/inst_test123";
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("fetch must not be used for Agent Vault control calls");
        }),
      );
      const plugin = require("../../lib/plugin/agent-vault");
      let tool;
      plugin.register({
        registerTool: (registered) => {
          tool = registered;
        },
      });

      const result = await tool.execute("call-1", {
        service: {
          name: "github",
          host: "api.github.com",
          auth: { type: "bearer", token: "GITHUB_TOKEN" },
        },
        credentials: [
          {
            key: "GITHUB_TOKEN",
            description: "GitHub API credential",
          },
        ],
        reason: "Publish a release",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        status: "available",
        service: {
          name: "github",
          host: "api.github.com",
        },
        credential_keys: ["GITHUB_TOKEN"],
        request_instructions: [
          "Do not supply an Authorization credential when calling api.github.com; Agent Vault injects it at the proxy.",
        ],
      });
      expect(received).toEqual([
        {
          url: "/discover",
          authorization: "Bearer av_agt_runtime_token_123456789",
          vault: "default",
          body: "",
        },
      ]);

      const proposalResult = await tool.execute("call-2", {
        service: {
          name: "openweathermap",
          host: "api.openweathermap.org",
          auth: { type: "passthrough" },
          substitutions: [
            {
              key: "OPENWEATHERMAP_API_KEY",
              in: ["query"],
            },
          ],
        },
        credentials: [
          {
            key: "OPENWEATHERMAP_API_KEY",
            description: "OpenWeatherMap API key",
          },
        ],
        reason: "Fetch the current weather directly",
        requestInstructions:
          "Set the appid query parameter to __openweathermap_api_key__.",
      });

      expect(JSON.parse(proposalResult.content[0].text)).toEqual({
        status: "proposal_created",
        service: {
          name: "openweathermap",
          host: "api.openweathermap.org",
        },
        credential_keys: ["OPENWEATHERMAP_API_KEY"],
        request_instructions: [
          "Set the appid query parameter to __openweathermap_api_key__.",
          "Use the exact placeholder __openweathermap_api_key__ wherever OPENWEATHERMAP_API_KEY belongs in the query portion of requests to api.openweathermap.org.",
        ],
        proposed_changes: {
          service: true,
          credentials: ["OPENWEATHERMAP_API_KEY"],
        },
        proposal_id: 12,
        approval_url:
          "https://www.teamyou.com/openclaw/agent-vault/inst_test123?return_to=%2Fapprove%2F12%3Ftoken%3Donce",
        instruction:
          "Return approval_url to the user. Do not ask the user to send credential values in chat. After approval, call ensure_service_access again, then follow request_instructions exactly.",
      });
      expect(proposalResult).not.toHaveProperty("isError");
      expect(received).toHaveLength(3);
      expect(received[1]).toMatchObject({
        url: "/discover",
        body: "",
      });
      expect(received[2]).toMatchObject({
        url: "/v1/proposals",
        authorization: "Bearer av_agt_runtime_token_123456789",
        vault: "default",
      });
      expect(JSON.parse(received[2].body)).toEqual({
        services: [
          {
            action: "set",
            name: "openweathermap",
            host: "api.openweathermap.org",
            auth: { type: "passthrough" },
            substitutions: [
              {
                key: "OPENWEATHERMAP_API_KEY",
                placeholder: "__openweathermap_api_key__",
                in: ["query"],
              },
            ],
          },
        ],
        credentials: [
          {
            action: "set",
            key: "OPENWEATHERMAP_API_KEY",
            type: "static",
            description: "OpenWeatherMap API key",
          },
        ],
        message: "Fetch the current weather directly",
        user_message: "Fetch the current weather directly",
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(previousEnv)) {
        const envKey =
          key === "address"
            ? "AGENT_VAULT_ADDR"
            : key === "token"
              ? "AGENT_VAULT_TOKEN"
              : key === "vault"
                ? "AGENT_VAULT_VAULT"
                : key === "operatorUrl"
                  ? "AGENT_VAULT_OPERATOR_URL"
                  : "TEAMYOU_AGENT_VAULT_ENTRY_URL";
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
  });

  it("returns the TeamYou setup link instead of suggesting an environment variable", async () => {
    const previousEnv = {
      address: process.env.AGENT_VAULT_ADDR,
      token: process.env.AGENT_VAULT_TOKEN,
      vault: process.env.AGENT_VAULT_VAULT,
      entryUrl: process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL,
    };
    try {
      delete process.env.AGENT_VAULT_ADDR;
      delete process.env.AGENT_VAULT_TOKEN;
      delete process.env.AGENT_VAULT_VAULT;
      process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL =
        "https://www.teamyou.com/openclaw/agent-vault/inst_test123";
      const plugin = require("../../lib/plugin/agent-vault");
      let tool;
      const hooks = {};
      plugin.register({
        on: (name, handler) => {
          hooks[name] = handler;
        },
        registerTool: (registered) => {
          tool = registered;
        },
      });

      const result = await tool.execute("call-setup", {
        service: {
          name: "openweathermap",
          host: "api.openweathermap.org",
          auth: { type: "passthrough" },
          substitutions: [
            {
              key: "OPENWEATHERMAP_API_KEY",
              in: ["query"],
            },
          ],
        },
        credentials: [
          {
            key: "OPENWEATHERMAP_API_KEY",
            description: "OpenWeatherMap API key",
          },
        ],
        reason: "Fetch current weather directly",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        status: "setup_required",
        setup_url:
          "https://www.teamyou.com/openclaw/agent-vault/inst_test123",
        instruction:
          "Return setup_url to the user and ask them to open it to initialize Agent Vault. Do not tell the user to add an environment variable or send a credential in chat. After setup completes, call ensure_service_access again.",
      });
      expect(result).not.toHaveProperty("isError");

      expect(
        hooks.before_agent_finalize({
          runId: "weather-run",
          lastAssistantMessage:
            "No API key is configured. Add an `OPENWEATHER_API_KEY` environment variable, then ask me to retry.",
        }),
      ).toEqual({
        action: "revise",
        reason: "Agent Vault must broker third-party credentials",
        retry: {
          instruction:
            "Your draft incorrectly directs the user to configure a third-party credential in an environment variable. Do not send that response. Call ensure_service_access now with the complete service rule and value-less credential metadata. If it returns setup_required or proposal_created, return its exact setup_url or approval_url to the user. Never fall back to Envars or Runtime Configuration.",
          idempotencyKey: "agent-vault-credential-policy:weather-run",
          maxAttempts: 2,
        },
      });
      expect(
        hooks.reply_payload_sending({
          kind: "final",
          payload: {
            text: "Add an OPENWEATHER_API_KEY environment variable.",
          },
        }),
      ).toEqual({
        payload: {
          text:
            "Agent Vault needs to be initialized before I can request this service credential. Open https://www.teamyou.com/openclaw/agent-vault/inst_test123, then ask me to retry. I will use the Agent Vault approval workflow instead of an environment variable.",
        },
      });
      expect(
        hooks.before_agent_finalize({
          lastAssistantMessage:
            "Never add OPENWEATHER_API_KEY as an environment variable; use Agent Vault.",
        }),
      ).toBeUndefined();
      expect(
        hooks.before_agent_finalize({
          lastAssistantMessage:
            "Configure OPENAI_API_KEY as an environment variable for the selected model provider.",
        }),
      ).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        const envKey =
          key === "address"
            ? "AGENT_VAULT_ADDR"
            : key === "token"
              ? "AGENT_VAULT_TOKEN"
              : key === "vault"
                ? "AGENT_VAULT_VAULT"
                : "TEAMYOU_AGENT_VAULT_ENTRY_URL";
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
  });

  it("reports the safe stage and status for Agent Vault HTTP failures", async () => {
    const previousEnv = {
      address: process.env.AGENT_VAULT_ADDR,
      token: process.env.AGENT_VAULT_TOKEN,
      vault: process.env.AGENT_VAULT_VAULT,
      operatorUrl: process.env.AGENT_VAULT_OPERATOR_URL,
      entryUrl: process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL,
    };
    const server = http.createServer((_req, res) => {
      const body = JSON.stringify({ error: "Invalid URL" });
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      });
      res.end(body);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(14321, "127.0.0.1", resolve);
    });
    try {
      process.env.AGENT_VAULT_ADDR = "http://127.0.0.1:14321";
      process.env.AGENT_VAULT_TOKEN = "av_agt_runtime_token_123456789";
      process.env.AGENT_VAULT_VAULT = "default";
      process.env.AGENT_VAULT_OPERATOR_URL =
        "https://agent-vault-test.tail123.ts.net";
      process.env.TEAMYOU_AGENT_VAULT_ENTRY_URL =
        "https://www.teamyou.com/openclaw/agent-vault/inst_test123";
      const plugin = require("../../lib/plugin/agent-vault");
      let tool;
      plugin.register({
        registerTool: (registered) => {
          tool = registered;
        },
      });

      const result = await tool.execute("call-error", {
        service: {
          name: "openweathermap",
          host: "api.openweathermap.org",
          auth: { type: "passthrough" },
          substitutions: [
            {
              key: "OPENWEATHERMAP_API_KEY",
              in: ["query"],
            },
          ],
        },
        credentials: [
          {
            key: "OPENWEATHERMAP_API_KEY",
            description: "OpenWeatherMap API key",
          },
        ],
        reason: "Fetch current weather directly",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        status: "error",
        stage: "discovery",
        http_status: 400,
        error: "Invalid URL",
      });
      expect(result.isError).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(previousEnv)) {
        const envKey =
          key === "address"
            ? "AGENT_VAULT_ADDR"
            : key === "token"
              ? "AGENT_VAULT_TOKEN"
              : key === "vault"
                ? "AGENT_VAULT_VAULT"
                : key === "operatorUrl"
                  ? "AGENT_VAULT_OPERATOR_URL"
                  : "TEAMYOU_AGENT_VAULT_ENTRY_URL";
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
  });
});
