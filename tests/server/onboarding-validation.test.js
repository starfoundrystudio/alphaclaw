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
