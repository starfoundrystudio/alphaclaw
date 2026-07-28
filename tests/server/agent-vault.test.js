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
          available_credentials: ["STRIPE_API_KEY"],
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
    const service = createAgentVaultService({
      env: {},
      readEnvFile: () => envVars,
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      openclawDir,
      fetchImpl,
      gatewayTailscaleClientFactory: () => gatewayClient,
    });

    await expect(service.claimRuntimeToken()).resolves.toMatchObject({
      ready: true,
      claimed: true,
      restartRequired: true,
    });
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

    await expect(
      service.ensureCredential({
        key: "github_token",
        description: "GitHub API token",
        reason: "Publish the requested release",
      }),
    ).resolves.toMatchObject({
      status: "proposal_created",
      key: "GITHUB_TOKEN",
      proposal: {
        id: 7,
        approvalUrl:
          "https://www.teamyou.com/openclaw/agent-vault/inst_test123?return_to=%2Fapprove%2F7%3Ftoken%3Donce",
      },
    });
    const proposalRequest = requests.find(({ url }) =>
      url.endsWith("/v1/proposals"),
    );
    const proposalBody = JSON.parse(proposalRequest.options.body);
    expect(proposalBody.credentials).toEqual([
      {
        action: "set",
        key: "GITHUB_TOKEN",
        description: "GitHub API token",
      },
    ]);
    expect(proposalBody.credentials[0]).not.toHaveProperty("value");
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
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        vault: req.headers["x-vault"],
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          vault: "default",
          services: [],
          available_credentials: ["GITHUB_TOKEN"],
        }),
      );
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
        key: "GITHUB_TOKEN",
        description: "GitHub API credential",
        reason: "Publish a release",
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        status: "available",
        key: "GITHUB_TOKEN",
      });
      expect(received).toEqual([
        {
          url: "/discover",
          authorization: "Bearer av_agt_runtime_token_123456789",
          vault: "default",
        },
      ]);
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
});
