const loadModelConfig = async () =>
  import("../../lib/public/js/lib/model-config.js");

describe("frontend/model-config", () => {
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
});
