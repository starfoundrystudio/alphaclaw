const fs = require("fs");
const os = require("os");
const path = require("path");

const kVaultUrl = "https://abc123def456-vault.teamyou.io";
const kSetupUrl = "https://abc123def456.teamyou.io";
const kHooksUrl = "https://abc123def456-hooks.teamyou.io";
const kTailnetVaultUrl = "https://agent-vault-test.tail123.ts.net";
const kEntryUrl =
  "https://www.teamyou.com/openclaw/agent-vault/inst_abc123/";

const kEnvKeys = [
  "ALPHACLAW_ROOT_DIR",
  "ALPHACLAW_INGRESS_MODE",
  "AGENT_VAULT_OPERATOR_URL",
  "ALPHACLAW_SETUP_URL",
  "ALPHACLAW_PUBLIC_BASE_URL",
];

describe("tunnel-mode URL validators", () => {
  let rootDir;
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(kEnvKeys.map((key) => [key, process.env[key]]));
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tunnel-validators-"));
    process.env.ALPHACLAW_ROOT_DIR = rootDir;
    for (const key of kEnvKeys.slice(1)) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const writeRuntime = (operatorUrl) => {
    const store = require("../../lib/server/agent-vault/runtime-store");
    store.writeAgentVaultRuntime({
      token: "av_runtime_token_123456789",
      operatorUrl,
    });
    return store.readAgentVaultRuntime();
  };

  describe("agent vault runtime store", () => {
    it("keeps the tailnet rule in tailscale mode", () => {
      expect(writeRuntime(kTailnetVaultUrl).operatorUrl).toBe(kTailnetVaultUrl);
      vi.resetModules();
      expect(() => writeRuntime(kVaultUrl)).toThrow(
        "Agent Vault operator URL is invalid",
      );
    });

    it("accepts only the configured vault origin in tunnel mode", () => {
      process.env.ALPHACLAW_INGRESS_MODE = "cloudflare_tunnel";
      process.env.AGENT_VAULT_OPERATOR_URL = kVaultUrl;
      expect(writeRuntime(`${kVaultUrl}/`).operatorUrl).toBe(kVaultUrl);
      vi.resetModules();
      expect(() => writeRuntime(kTailnetVaultUrl)).toThrow(
        "Agent Vault operator URL is invalid",
      );
      vi.resetModules();
      expect(() => writeRuntime("https://evil.abc123def456-vault.teamyou.io")).toThrow(
        "Agent Vault operator URL is invalid",
      );
    });

    it("rejects tunnel runtime state when no vault URL is configured", () => {
      process.env.ALPHACLAW_INGRESS_MODE = "cloudflare_tunnel";
      expect(() => writeRuntime(kVaultUrl)).toThrow(
        "Agent Vault operator URL is invalid",
      );
    });
  });

  describe("approval links", () => {
    const approvalUrl = (origin) => `${origin}/approve/7?token=abc`;
    const {
      buildTeamYouAgentVaultApprovalUrl,
    } = require("../../lib/agent-vault-links");

    it("keeps the tailnet rule in tailscale mode", () => {
      expect(
        buildTeamYouAgentVaultApprovalUrl({
          approvalUrl: approvalUrl(kTailnetVaultUrl),
          operatorUrl: kTailnetVaultUrl,
          entryUrl: kEntryUrl,
          env: {},
        }),
      ).toContain("return_to=%2Fapprove%2F7%3Ftoken%3Dabc");
      expect(() =>
        buildTeamYouAgentVaultApprovalUrl({
          approvalUrl: approvalUrl(kVaultUrl),
          operatorUrl: kVaultUrl,
          entryUrl: kEntryUrl,
          env: {},
        }),
      ).toThrow("Agent Vault operator URL is invalid");
    });

    it("requires the configured vault origin in tunnel mode", () => {
      const env = {
        ALPHACLAW_INGRESS_MODE: "cloudflare_tunnel",
        AGENT_VAULT_OPERATOR_URL: kVaultUrl,
      };
      expect(
        buildTeamYouAgentVaultApprovalUrl({
          approvalUrl: approvalUrl(kVaultUrl),
          operatorUrl: kVaultUrl,
          entryUrl: kEntryUrl,
          env,
        }),
      ).toContain(kEntryUrl);
      for (const origin of [kTailnetVaultUrl, "https://other-vault.teamyou.io"]) {
        expect(() =>
          buildTeamYouAgentVaultApprovalUrl({
            approvalUrl: approvalUrl(origin),
            operatorUrl: origin,
            entryUrl: kEntryUrl,
            env,
          }),
        ).toThrow("Agent Vault operator URL is invalid");
      }
    });
  });

  describe("agent vault service operator URL", () => {
    const createService = (env) => {
      // The runtime-store tests above may leave runtime state behind in a
      // cached module root; this block is about the env-configured URL only.
      const { kAgentVaultRuntimePath } = require("../../lib/server/agent-vault/runtime-store");
      fs.rmSync(kAgentVaultRuntimePath, { force: true });
      const { createAgentVaultService } = require("../../lib/server/agent-vault/service");
      return createAgentVaultService({
        env,
        readEnvFile: () => [],
        openclawDir: path.join(rootDir, ".openclaw"),
      });
    };

    it("rejects a tunnel URL in tailscale mode", () => {
      expect(
        createService({ AGENT_VAULT_OPERATOR_URL: kVaultUrl }).getVaultOperatorUrl(),
      ).toBe("");
      expect(
        createService({ AGENT_VAULT_OPERATOR_URL: kTailnetVaultUrl }).getVaultOperatorUrl(),
      ).toBe(kTailnetVaultUrl);
    });

    it("accepts the configured origin in tunnel mode and nothing malformed", () => {
      expect(
        createService({
          ALPHACLAW_INGRESS_MODE: "cloudflare_tunnel",
          AGENT_VAULT_OPERATOR_URL: `${kVaultUrl}/`,
        }).getVaultOperatorUrl(),
      ).toBe(kVaultUrl);
      expect(
        createService({
          ALPHACLAW_INGRESS_MODE: "cloudflare_tunnel",
          AGENT_VAULT_OPERATOR_URL: `${kVaultUrl}:8443`,
        }).getVaultOperatorUrl(),
      ).toBe("");
    });
  });

  describe("gateway client status parsing (contract C4)", () => {
    const {
      normalizeGatewayStatus,
    } = require("../../lib/server/onboarding/gateway-tailscale-client");
    const tunnelResponse = (overrides = {}) => ({
      schema_version: 2,
      operation: "status",
      ok: true,
      configured: true,
      sealed: true,
      ingress_mode: "cloudflare_tunnel",
      setup_url: kSetupUrl,
      public_base_url: kHooksUrl,
      agent_vault_operator_url: kVaultUrl,
      ...overrides,
    });
    const configuredEnv = {
      ALPHACLAW_SETUP_URL: kSetupUrl,
      ALPHACLAW_PUBLIC_BASE_URL: kHooksUrl,
      AGENT_VAULT_OPERATOR_URL: kVaultUrl,
    };

    it("returns the tunnel shape when the URLs match the configured env", () => {
      expect(
        normalizeGatewayStatus(tunnelResponse(), "status", { env: configuredEnv }),
      ).toEqual({
        configured: true,
        sealed: true,
        ingressMode: "cloudflare_tunnel",
        setupUrl: kSetupUrl,
        publicBaseUrl: kHooksUrl,
        agentVaultOperatorUrl: kVaultUrl,
      });
    });

    it("skips the equality check for env values that are not set", () => {
      expect(
        normalizeGatewayStatus(tunnelResponse(), "status", { env: {} }).setupUrl,
      ).toBe(kSetupUrl);
    });

    it("rejects URLs that differ from the configured env", () => {
      expect(() =>
        normalizeGatewayStatus(
          tunnelResponse({ setup_url: "https://other.teamyou.io" }),
          "status",
          { env: configuredEnv },
        ),
      ).toThrow("Gateway setup URL does not match this instance");
      expect(() =>
        normalizeGatewayStatus(
          tunnelResponse({ agent_vault_operator_url: "https://x.abc123def456-vault.teamyou.io" }),
          "status",
          { env: configuredEnv },
        ),
      ).toThrow("Agent Vault operator URL does not match this instance");
    });

    it("rejects URLs that are not bare https origins", () => {
      for (const bad of [
        "http://abc123def456.teamyou.io",
        "https://abc123def456.teamyou.io:8443",
        "https://abc123def456.teamyou.io/setup",
      ]) {
        expect(() =>
          normalizeGatewayStatus(tunnelResponse({ setup_url: bad }), "status", {
            env: {},
          }),
        ).toThrow("Gateway setup URL is invalid");
      }
      expect(() =>
        normalizeGatewayStatus(tunnelResponse({ public_base_url: "" }), "status", {
          env: {},
        }),
      ).toThrow("Gateway public base URL is missing or invalid");
    });

    it("rejects unknown ingress modes and keeps the Tailscale parse path", () => {
      expect(() =>
        normalizeGatewayStatus(tunnelResponse({ ingress_mode: "ngrok" }), "status"),
      ).toThrow("Gateway ingress mode is unsupported");
      expect(
        normalizeGatewayStatus(
          {
            schema_version: 2,
            operation: "status",
            ok: true,
            configured: true,
            sealed: false,
            tailscale_dns: "gw.tail123.ts.net",
            tailscale_device_id: "n123",
            tailnet: "example.com",
            agent_vault_operator_url: kTailnetVaultUrl,
          },
          "status",
        ),
      ).toEqual({
        configured: true,
        sealed: false,
        dnsName: "gw.tail123.ts.net",
        deviceId: "n123",
        tailnet: "example.com",
        agentVaultOperatorUrl: kTailnetVaultUrl,
      });
    });

    it("reports an unconfigured tunnel state", () => {
      expect(
        normalizeGatewayStatus(
          { schema_version: 2, operation: "status", ok: true, configured: false, ingress_mode: "cloudflare_tunnel" },
          "status",
        ),
      ).toEqual({ configured: false, sealed: false, ingressMode: "cloudflare_tunnel" });
    });
  });
});
