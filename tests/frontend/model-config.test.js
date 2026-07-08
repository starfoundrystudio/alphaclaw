const loadModelConfig = async () =>
  import("../../lib/public/js/lib/model-config.js");

describe("frontend/model-config", () => {
  it("defaults model selection flows to subscription access", async () => {
    const modelConfig = await loadModelConfig();

    expect(modelConfig.getDefaultModelAccessMode()).toBe("subscription");
  });

  it("maps openai-codex auth provider to openai", async () => {
    const modelConfig = await loadModelConfig();
    expect(modelConfig.getAuthProviderFromModelProvider("openai-codex")).toBe("openai");
    expect(modelConfig.getAuthProviderFromModelProvider("volcengine-plan")).toBe(
      "volcengine",
    );
    expect(modelConfig.getAuthProviderFromModelProvider("byteplus-plan")).toBe(
      "byteplus",
    );
    expect(modelConfig.getAuthProviderFromModelProvider("google")).toBe("google");
  });

  it("returns visible AI field keys for provider", async () => {
    const modelConfig = await loadModelConfig();
    const keys = modelConfig.getVisibleAiFieldKeys("openai-codex");
    expect(keys.has("OPENAI_API_KEY")).toBe(false);
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(false);
    const zaiKeys = modelConfig.getVisibleAiFieldKeys("zai");
    expect(zaiKeys.has("ZAI_API_KEY")).toBe(true);
    const volcengineKeys = modelConfig.getVisibleAiFieldKeys("volcengine-plan");
    expect(volcengineKeys.has("VOLCANO_ENGINE_API_KEY")).toBe(true);
  });

  it("describes and validates Vercel AI Gateway key format", async () => {
    const modelConfig = await loadModelConfig();
    const [field] = modelConfig.kProviderAuthFields["vercel-ai-gateway"];

    expect(field.placeholder).toBe("vck_...");
    expect(field.requiredPrefix).toBe("vck_");
    expect(modelConfig.getAiCredentialFieldError(field, "vck_live_test")).toBe("");
    expect(modelConfig.getAiCredentialFieldError(field, "not-a-vercel-key")).toBe(
      "AI Gateway API Key must start with vck_",
    );
  });

  it("does not validate stale unrelated credentials for model-only saves", async () => {
    const modelConfig = await loadModelConfig();

    const fields = modelConfig.getAiCredentialFieldsForSave({
      modelDirty: true,
      selectedModelProvider: "openai",
      selectedAuthProvider: "openai",
      dirtyCredentialKeys: [],
    });

    expect(fields.map((field) => field.key)).toEqual(["OPENAI_API_KEY"]);
    expect(
      modelConfig.getAiCredentialErrorForFields(
        {
          OPENAI_API_KEY: "sk-test",
          AI_GATEWAY_API_KEY: "aigw-stale-hidden-value",
        },
        fields,
      ),
    ).toBe("");
  });

  it("validates dirty credentials even when another provider is selected", async () => {
    const modelConfig = await loadModelConfig();

    const fields = modelConfig.getAiCredentialFieldsForSave({
      modelDirty: true,
      selectedModelProvider: "openai",
      selectedAuthProvider: "openai",
      dirtyCredentialKeys: ["AI_GATEWAY_API_KEY"],
    });

    expect(fields.map((field) => field.key)).toEqual([
      "OPENAI_API_KEY",
      "AI_GATEWAY_API_KEY",
    ]);
    expect(
      modelConfig.getAiCredentialErrorForFields(
        {
          OPENAI_API_KEY: "sk-test",
          AI_GATEWAY_API_KEY: "aigw-edited-value",
        },
        fields,
      ),
    ).toBe("AI Gateway API Key must start with vck_");
  });

  it("validates the selected provider credentials for model changes", async () => {
    const modelConfig = await loadModelConfig();

    const fields = modelConfig.getAiCredentialFieldsForSave({
      modelDirty: true,
      selectedModelProvider: "vercel-ai-gateway",
      selectedAuthProvider: "vercel-ai-gateway",
      dirtyCredentialKeys: [],
    });

    expect(fields.map((field) => field.key)).toEqual(["AI_GATEWAY_API_KEY"]);
    expect(
      modelConfig.getAiCredentialErrorForFields(
        { AI_GATEWAY_API_KEY: "not-a-vercel-key" },
        fields,
      ),
    ).toBe("AI Gateway API Key must start with vck_");
  });

  it("picks featured models in defined preference order", async () => {
    const modelConfig = await loadModelConfig();
    const featured = modelConfig.getFeaturedModels([
      { key: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
      { key: "anthropic/claude-opus-4-7", label: "Opus 4.7" },
      { key: "anthropic/claude-opus-4-6", label: "Opus 4.6" },
      { key: "anthropic/claude-sonnet-4-6", label: "Sonnet 4.6" },
      { key: "openai/gpt-5.3-codex", label: "Codex 5.3" },
      { key: "openai/gpt-5.4", label: "GPT-5.4" },
      { key: "openai/gpt-5.5", label: "GPT-5.5" },
    ]);

    expect(featured.map((entry) => entry.key)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.5",
    ]);
    expect(featured[0]?.featuredLabel).toBe("Opus 4.8");
    expect(featured[1]?.featuredLabel).toBe("Sonnet 4.6");
    expect(featured[2]?.featuredLabel).toBe("GPT-5.5");
    expect(featured.some((entry) => entry.featuredLabel === "Gemini 3.1 Pro")).toBe(
      false,
    );
  });

  it("keeps recommended onboarding models to canonical provider entries", async () => {
    const modelConfig = await loadModelConfig();
    const featured = modelConfig.getFeaturedModels([
      {
        key: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
      },
      {
        key: "openrouter/anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
      },
      {
        key: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
      },
    ]);

    expect(featured.map((entry) => entry.key)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("adds the provider label when a model family has multiple onboarding variants", async () => {
    const modelConfig = await loadModelConfig();
    const catalog = [
      {
        key: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        featuredLabel: "Opus 4.6",
      },
      {
        key: "openrouter/anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        featuredLabel: "Opus 4.6",
      },
    ];

    expect(modelConfig.getOnboardingModelLabel(catalog[0], catalog)).toBe(
      "Opus 4.6 (Anthropic)",
    );
    expect(modelConfig.getOnboardingModelLabel(catalog[1], catalog)).toBe(
      "Opus 4.6 (OpenRouter)",
    );
  });

  it("adds the provider label when different providers share the same label", async () => {
    const modelConfig = await loadModelConfig();
    const catalog = [
      { key: "openai/gpt-5.5", label: "GPT-5.5" },
      { key: "azure-openai-responses/gpt-5.5", label: "GPT-5.5" },
    ];

    expect(modelConfig.getOnboardingModelLabel(catalog[0], catalog)).toBe(
      "GPT-5.5 (OpenAI)",
    );
    expect(modelConfig.getOnboardingModelLabel(catalog[1], catalog)).toBe(
      "GPT-5.5 (Azure OpenAI)",
    );
  });

  it("hides legacy OpenAI Codex model routes from onboarding choices", async () => {
    const modelConfig = await loadModelConfig();

    expect(
      modelConfig.isVisibleOnboardingModel({ key: "openai-codex/gpt-5.5" }),
    ).toBe(false);
    expect(modelConfig.isVisibleOnboardingModel({ key: "openai/gpt-5.5" })).toBe(
      true,
    );
  });

  it("groups full onboarding model options by recommendation tier", async () => {
    const modelConfig = await loadModelConfig();
    const recommended = [
      { key: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
      { key: "openai/gpt-5.5", label: "GPT-5.5" },
    ];
    const groups = modelConfig.getOnboardingModelGroups({
      allModels: [
        ...recommended,
        { key: "anthropic/claude-haiku-4-6", label: "Claude Haiku 4.6" },
        { key: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
        { key: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      ],
      recommendedModels: recommended,
    });

    expect(groups.map((group) => group.label)).toEqual([
      "Recommended",
      "Lower cost",
      "Advanced",
    ]);
    expect(groups[0].models.map((model) => model.key)).toEqual([
      "anthropic/claude-opus-4-8",
      "openai/gpt-5.5",
    ]);
    expect(groups[1].models.map((model) => model.key)).toEqual([
      "anthropic/claude-haiku-4-6",
      "google/gemini-3-flash-preview",
    ]);
    expect(groups[2].models.map((model) => model.key)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("sorts onboarding model choices by higher numeric model versions first", async () => {
    const modelConfig = await loadModelConfig();
    const sorted = modelConfig.sortOnboardingModelsByVersionedName([
      { key: "vercel-ai-gateway/openai/gpt-5.4", label: "GPT 5.4" },
      { key: "vercel-ai-gateway/anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
      { key: "vercel-ai-gateway/openai/gpt-5.5", label: "GPT-5.5" },
      { key: "vercel-ai-gateway/anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
    ]);

    expect(sorted.map((model) => model.key)).toEqual([
      "vercel-ai-gateway/anthropic/claude-opus-4.8",
      "vercel-ai-gateway/anthropic/claude-opus-4.6",
      "vercel-ai-gateway/openai/gpt-5.5",
      "vercel-ai-gateway/openai/gpt-5.4",
    ]);
  });

  it("filters onboarding models by access mode and supplements known gateway routes", async () => {
    const modelConfig = await loadModelConfig();
    const catalog = modelConfig.getOnboardingModelCatalog([
      { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
      { key: "github-copilot/gpt-5.5", label: "GPT-5.5" },
    ]);

    expect(
      modelConfig
        .getOnboardingModelsForAccessMode({
          models: catalog,
          accessMode: "provider-api",
        })
        .map((model) => model.key),
    ).toContain("anthropic/claude-opus-4-8");
    const subscriptionKeys = modelConfig
      .getOnboardingModelsForAccessMode({
        models: catalog,
        accessMode: "subscription",
      })
      .map((model) => model.key);
    expect(subscriptionKeys).toContain("openai/gpt-5.5");
    expect(subscriptionKeys).not.toContain("github-copilot/gpt-5.5");
    expect(modelConfig.isSetupReadyAccountLoginProvider("openai")).toBe(true);
    expect(modelConfig.isSetupReadyAccountLoginProvider("claude-cli")).toBe(true);
    expect(modelConfig.isSetupReadyAccountLoginProvider("github-copilot")).toBe(
      false,
    );
    expect(
      modelConfig
        .getOnboardingModelsForAccessMode({
          models: catalog,
          accessMode: "gateway",
        })
        .map((model) => model.key),
    ).toEqual([
      "openrouter/openai/gpt-5.5",
      "vercel-ai-gateway/openai/gpt-5.5",
      "kilocode/openai/gpt-5.5",
    ]);
  });

  it("adds route context to gateway onboarding model descriptions", async () => {
    const modelConfig = await loadModelConfig();

    expect(
      modelConfig.getOnboardingModelDescription({
        key: "vercel-ai-gateway/openai/gpt-5.5",
        label: "GPT-5.5",
        accessLabel: "via Vercel AI Gateway",
      }),
    ).toBe("via Vercel AI Gateway");
  });

  it("builds account login provider choices and scopes models by account provider", async () => {
    const modelConfig = await loadModelConfig();
    const catalog = modelConfig.getOnboardingModelCatalog([
      { key: "claude-cli/claude-opus-4-8", label: "Claude Opus 4.8" },
      { key: "github-copilot/gpt-5.5", label: "GPT-5.5" },
    ]);

    expect(
      modelConfig.getAccountLoginProviderOptions(catalog).map((option) => option.id),
    ).toEqual(["openai", "claude-cli"]);
    expect(
      modelConfig
        .getAccountLoginProviderOptions(catalog)
        .find((option) => option.id === "openai"),
    ).toMatchObject({
      label: "ChatGPT",
      description: "Use your ChatGPT subscription through Codex OAuth.",
    });
    expect(
      modelConfig
        .getAccountLoginProviderOptions(catalog)
        .find((option) => option.id === "claude-cli"),
    ).toMatchObject({
      label: "Claude",
      description: "Use your Claude subscription through the Claude CLI.",
    });
    expect(
      modelConfig
        .getOnboardingModelsForAccountLoginProvider({
          models: catalog,
          provider: "claude-cli",
        })
        .map((model) => model.key),
    ).toEqual(["claude-cli/claude-opus-4-8"]);
    expect(
      modelConfig.getInitialModelKeyForAccountLoginProvider({
        models: catalog,
        provider: "openai",
      }),
    ).toBe("openai/gpt-5.5");
  });

  it("keeps legacy OpenAI Codex PI route mapping available for compatibility", async () => {
    const modelConfig = await loadModelConfig();

    expect(
      modelConfig.getCodexOauthModelKeyForOpenAiModel("openai/gpt-5.5", [
        { key: "openai-codex/gpt-5.5", label: "GPT-5.5" },
      ]),
    ).toBe("openai-codex/gpt-5.5");
    expect(
      modelConfig.getCodexOauthModelKeyForOpenAiModel("anthropic/claude-opus-4-6"),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("maps Codex OAuth model refs to canonical OpenAI refs for the Codex runtime", async () => {
    const modelConfig = await loadModelConfig();

    expect(
      modelConfig.getOpenAiModelKeyForCodexRuntimeModel("openai-codex/gpt-5.5", [
        { key: "openai/gpt-5.5", label: "GPT-5.5" },
      ]),
    ).toBe("openai/gpt-5.5");
    expect(
      modelConfig.getOpenAiModelKeyForCodexRuntimeModel("openai/gpt-5.5"),
    ).toBe("openai/gpt-5.5");
  });

  it("maps Claude CLI model refs to canonical Anthropic refs for the Claude CLI runtime", async () => {
    const modelConfig = await loadModelConfig();

    expect(
      modelConfig.getAnthropicModelKeyForClaudeCliRuntimeModel(
        "claude-cli/claude-opus-4-8",
      ),
    ).toBe("anthropic/claude-opus-4-8");
    expect(
      modelConfig.getAnthropicModelKeyForClaudeCliRuntimeModel(
        "anthropic/claude-sonnet-4-6",
      ),
    ).toBe("anthropic/claude-sonnet-4-6");
  });
});
