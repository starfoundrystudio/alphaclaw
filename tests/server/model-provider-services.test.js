const {
  buildModelProviderAccessRequests,
  buildPlaceholderForCredentialKey,
  getModelProviderVaultConfig,
  isVaultPlaceholderValue,
  kModelProviderVaultServices,
  listVaultBrokeredModelProviders,
} = require("../../lib/server/agent-vault/model-provider-services");
const {
  normalizeAgentVaultAccessRequest,
  planAgentVaultAccess,
} = require("../../lib/agent-vault-access");
const {
  getEnvVarForApiKeyProvider,
} = require("../../lib/server/auth-profiles");

describe("server/agent-vault/model-provider-services", () => {
  it("every registry entry maps to a known api-key provider", () => {
    for (const provider of Object.keys(kModelProviderVaultServices)) {
      expect(getEnvVarForApiKeyProvider(provider)).toBeTruthy();
      expect(getModelProviderVaultConfig(provider)).not.toBeNull();
    }
  });

  it("every access request passes the real Agent Vault validators", () => {
    for (const provider of listVaultBrokeredModelProviders()) {
      const requests = buildModelProviderAccessRequests(provider);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        const access = normalizeAgentVaultAccessRequest(request);
        expect(access.service.auth).toEqual({ type: "passthrough" });
        expect(access.service.substitutions).toHaveLength(1);
        const plan = planAgentVaultAccess(access, {
          services: [],
          available_credentials: [],
        });
        expect(plan.status).toBe("proposal_required");
        expect(plan.proposal.services).toHaveLength(1);
        expect(plan.proposal.credentials).toHaveLength(1);
      }
    }
  });

  it("uses the env var name as the credential slot and the agent_vault placeholder convention", () => {
    const config = getModelProviderVaultConfig("anthropic");
    expect(config.credentialKey).toBe("ANTHROPIC_API_KEY");
    expect(config.placeholder).toBe("__agent_vault_anthropic_api_key__");
    expect(config.services).toEqual([
      { name: "model-anthropic", host: "api.anthropic.com" },
    ]);
  });

  it("gives multi-host providers one service per host sharing one slot", () => {
    const config = getModelProviderVaultConfig("minimax");
    expect(config.services.map((service) => service.name)).toEqual([
      "model-minimax",
      "model-minimax-2",
    ]);
    const requests = buildModelProviderAccessRequests("minimax");
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((r) => r.credentials[0].key)).size).toBe(1);
  });

  it("routes plan-variant providers to the base provider's service", () => {
    const plan = getModelProviderVaultConfig("volcengine-plan");
    const base = getModelProviderVaultConfig("volcengine");
    expect(plan.services).toEqual(base.services);
    expect(plan.credentialKey).toBe(base.credentialKey);
    expect(plan.placeholder).toBe(base.placeholder);
  });

  it("adds the query surface for google", () => {
    const config = getModelProviderVaultConfig("google");
    expect(config.surfaces).toEqual(["header", "query"]);
    const [request] = buildModelProviderAccessRequests("google");
    expect(request.service.substitutions[0].in).toEqual(["header", "query"]);
  });

  it("returns null for providers outside the registry", () => {
    expect(getModelProviderVaultConfig("vllm")).toBeNull();
    expect(getModelProviderVaultConfig("claude-cli")).toBeNull();
    expect(getModelProviderVaultConfig("")).toBeNull();
    expect(buildModelProviderAccessRequests("vllm")).toBeNull();
  });

  it("detects placeholder values by shape, including the TeamYou runtime placeholder", () => {
    expect(isVaultPlaceholderValue("__agent_vault_anthropic_api_key__")).toBe(
      true,
    );
    expect(isVaultPlaceholderValue("__agent_vault_teamyou_api_key__")).toBe(
      true,
    );
    expect(isVaultPlaceholderValue(" __agent_vault_openai_api_key__ ")).toBe(
      true,
    );
    expect(isVaultPlaceholderValue("sk-ant-api03-abc")).toBe(false);
    expect(isVaultPlaceholderValue("__anthropic_api_key__")).toBe(false);
    expect(isVaultPlaceholderValue("")).toBe(false);
    expect(isVaultPlaceholderValue(null)).toBe(false);
  });

  it("builds placeholders that satisfy the vault placeholder rules", () => {
    for (const provider of listVaultBrokeredModelProviders()) {
      const { placeholder, credentialKey } =
        getModelProviderVaultConfig(provider);
      expect(placeholder).toBe(buildPlaceholderForCredentialKey(credentialKey));
      expect(isVaultPlaceholderValue(placeholder)).toBe(true);
    }
  });
});
