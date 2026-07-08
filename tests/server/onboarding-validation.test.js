const { validateOnboardingInput } = require("../../lib/server/onboarding/validation");

const kBaseVars = ({
  includeChannel = true,
  includeGithub = true,
} = {}) => [
  ...(includeGithub
    ? [
        { key: "GITHUB_TOKEN", value: "ghp_test" },
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
      ]
    : []),
  ...(includeChannel
    ? [{ key: "TELEGRAM_BOT_TOKEN", value: "telegram_tok" }]
    : []),
];

const kResolveProvider = (modelKey) => String(modelKey || "").split("/")[0] || "";

describe("onboarding/validation", () => {
  it("accepts OPENROUTER_API_KEY when the selected model uses the openrouter provider", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "OPENROUTER_API_KEY", value: "sk-or-test" }],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts Vercel AI Gateway keys that start with vck_", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "AI_GATEWAY_API_KEY", value: "vck_test" }],
      modelKey: "vercel-ai-gateway/openai/gpt-5.5",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects Vercel AI Gateway keys that do not start with vck_", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "AI_GATEWAY_API_KEY", value: "aigw-test" }],
      modelKey: "vercel-ai-gateway/openai/gpt-5.5",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("AI_GATEWAY_API_KEY must start with vck_");
  });

  it("accepts MOONSHOT_API_KEY when the selected model uses the moonshot provider", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "MOONSHOT_API_KEY", value: "sk-moonshot" }],
      modelKey: "moonshot/kimi-k2-5",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts onboarding without any channel tokens", () => {
    const res = validateOnboardingInput({
      vars: [
        ...kBaseVars({ includeChannel: false }),
        { key: "OPENROUTER_API_KEY", value: "sk-or-test" },
      ],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts an OpenAI model with Codex runtime when Codex OAuth is connected", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.data.agentRuntimeId).toBe("codex");
  });

  it("canonicalizes openai-codex models when Codex runtime is selected", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "openai-codex/gpt-5.5",
      agentRuntimeId: "codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.data.modelKey).toBe("openai/gpt-5.5");
    expect(res.data.selectedProvider).toBe("openai");
    expect(res.data.agentRuntimeId).toBe("codex");
  });

  it("does not route canonical OpenAI models through Codex OAuth without the Codex runtime", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "openai/gpt-5.5",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Missing credentials for selected provider "openai"');
  });

  it("rejects Codex runtime without Codex OAuth", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Connect OpenAI Codex OAuth before continuing");
  });

  it("rejects Codex runtime for non-OpenAI model providers", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-test" }],
      modelKey: "anthropic/claude-opus-4-6",
      agentRuntimeId: "codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Codex runtime requires an OpenAI model");
  });

  it("canonicalizes claude-cli models when Claude CLI runtime is selected", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "claude-cli/claude-opus-4-8",
      agentRuntimeId: "claude-cli",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      hasClaudeCliProfile: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.data.modelKey).toBe("anthropic/claude-opus-4-8");
    expect(res.data.selectedProvider).toBe("anthropic");
    expect(res.data.agentRuntimeId).toBe("claude-cli");
  });

  it("rejects Claude CLI runtime without a Claude CLI profile", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "claude-cli/claude-opus-4-8",
      agentRuntimeId: "claude-cli",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      hasClaudeCliProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Connect Claude CLI before continuing");
  });

  it("rejects Claude CLI runtime for non-Anthropic model providers", () => {
    const res = validateOnboardingInput({
      vars: kBaseVars({ includeChannel: false, includeGithub: false }),
      modelKey: "openai/gpt-5.5",
      agentRuntimeId: "claude-cli",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      hasClaudeCliProfile: () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Claude CLI runtime requires an Anthropic model");
  });

  it("accepts fresh onboarding without GitHub backup configured", () => {
    const res = validateOnboardingInput({
      vars: [
        ...kBaseVars({ includeChannel: false, includeGithub: false }),
        { key: "OPENROUTER_API_KEY", value: "sk-or-test" },
      ],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects partial GitHub backup input for fresh onboarding", () => {
    const res = validateOnboardingInput({
      vars: [
        ...kBaseVars({ includeChannel: false, includeGithub: false }),
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
        { key: "OPENROUTER_API_KEY", value: "sk-or-test" },
      ],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("GITHUB_TOKEN must be set to enable GitHub backup");
  });

  it("requires GitHub backup config for import onboarding", () => {
    const res = validateOnboardingInput({
      vars: [
        ...kBaseVars({ includeChannel: false, includeGithub: false }),
        { key: "OPENROUTER_API_KEY", value: "sk-or-test" },
      ],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      importMode: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "GitHub token and workspace repo are required to import an existing setup",
    );
  });

  it("rejects openrouter model when only unrelated API keys are present", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "MOONSHOT_API_KEY", value: "sk-ms" }],
      modelKey: "openrouter/foo/bar",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Missing credentials for selected provider "openrouter"');
  });

  it("accepts whatsapp owner number as the required channel credential", () => {
    const res = validateOnboardingInput({
      vars: [
        { key: "GITHUB_TOKEN", value: "ghp_test" },
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
        { key: "OPENAI_API_KEY", value: "sk-test-123" },
      ],
      modelKey: "openai/gpt-5.1-codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });
});
