const loadModelConfig = async () =>
  import("../../lib/public/js/lib/model-config.js");

describe("frontend/model-config", () => {
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

  it("picks featured models in defined preference order", async () => {
    const modelConfig = await loadModelConfig();
    const featured = modelConfig.getFeaturedModels([
      { key: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
      { key: "anthropic/claude-opus-4-7", label: "Opus 4.7" },
      { key: "anthropic/claude-opus-4-6", label: "Opus 4.6" },
      { key: "openai-codex/gpt-5.3-codex", label: "Codex 5.3" },
      { key: "openai-codex/gpt-5.4", label: "GPT-5.4" },
      { key: "openai-codex/gpt-5.5", label: "GPT-5.5" },
    ]);

    expect(featured.map((entry) => entry.key)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-6",
      "openai-codex/gpt-5.3-codex",
      "openai-codex/gpt-5.5",
      "google/gemini-3.1-pro-preview",
    ]);
    expect(featured[0]?.featuredLabel).toBe("Opus 4.8");
    expect(featured[1]?.featuredLabel).toBe("Opus 4.7");
    expect(featured[4]?.featuredLabel).toBe("GPT-5.5");
    expect(featured[5]?.featuredLabel).toBe("Gemini 3.1 Pro");
  });

  it("surfaces featured provider variants for the same Claude family", async () => {
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
      "openrouter/anthropic/claude-sonnet-4-6",
      "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
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

  it("maps canonical OpenAI model refs to the Codex OAuth PI route", async () => {
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
});
