describe("frontend/model-catalog", () => {
  it("returns catalog models when the payload is valid", async () => {
    const { getModelCatalogModels } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getModelCatalogModels({
        models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
    ).toEqual([{ key: "openai/gpt-5.4", label: "GPT-5.4" }]);
    expect(getModelCatalogModels(null)).toEqual([]);
  });

  it("merges per-access-mode provider catalogs into the inventory (OpenClaw 2026.9 payload)", async () => {
    // G2 finding #4: on 2026.9 `models` only lists configured providers'
    // inventory; other providers live under accessModes[mode].providers.
    const { getModelCatalogModels } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    const merged = getModelCatalogModels({
      models: [
        {
          key: "vercel-ai-gateway/anthropic/claude-opus-4.8",
          provider: "vercel-ai-gateway",
          label: "Claude Opus 4.8",
          accessModes: ["gateway"],
        },
        { key: "vercel-ai-gateway/alibaba/qwen-3-14b", label: "Qwen3-14B" },
      ],
      accessModes: {
        subscription: {
          providers: [
            {
              id: "claude-cli",
              models: [
                { key: "claude-cli/claude-opus-4-8", label: "Opus (Claude CLI)" },
              ],
            },
          ],
        },
        "provider-api": {
          providers: [
            {
              id: "anthropic",
              models: [
                {
                  key: "anthropic/claude-opus-4-8",
                  provider: "anthropic",
                  accessModes: ["provider-api"],
                },
              ],
            },
          ],
        },
        gateway: {
          providers: [
            {
              id: "vercel-ai-gateway",
              models: [
                // Duplicate of an inventory entry: inventory wins, mode kept.
                { key: "vercel-ai-gateway/anthropic/claude-opus-4.8", label: "dup" },
                { key: "vercel-ai-gateway/alibaba/qwen-3-14b", label: "dup" },
              ],
            },
            {
              id: "openrouter",
              models: [{ key: "openrouter/anthropic/claude-opus-4.8" }],
            },
          ],
        },
      },
    });

    expect(merged.map((m) => m.key)).toEqual([
      "vercel-ai-gateway/anthropic/claude-opus-4.8",
      "vercel-ai-gateway/alibaba/qwen-3-14b",
      "claude-cli/claude-opus-4-8",
      "anthropic/claude-opus-4-8",
      "openrouter/anthropic/claude-opus-4.8",
    ]);
    expect(merged[0].label).toBe("Claude Opus 4.8");
    expect(merged[0].accessModes).toEqual(["gateway"]);
    expect(merged[1].accessModes).toEqual(["gateway"]);
    expect(merged[2]).toMatchObject({
      provider: "claude-cli",
      accessModes: ["subscription"],
    });
    expect(merged[3].accessModes).toEqual(["provider-api"]);
    expect(merged[4]).toMatchObject({
      provider: "openrouter",
      accessModes: ["gateway"],
    });
    // Older payloads without accessModes pass through untouched.
    expect(
      getModelCatalogModels({ models: [{ key: "openai/gpt-5.4" }] }),
    ).toEqual([{ key: "openai/gpt-5.4" }]);
  });

  it("preserves an existing onboarding selection", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
        currentModelKey: "anthropic/claude-opus-4-6",
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("defaults to the recommended subscription model when available", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [
          {
            key: "openai/gpt-5.6-sol",
            label: "GPT-5.6 Sol",
            accessModes: ["subscription", "provider-api"],
            recommendation: "recommended",
            recommendedAccessModes: ["subscription"],
          },
          {
            key: "openai/gpt-5.5",
            label: "GPT-5.5",
            accessModes: ["subscription", "provider-api"],
          },
          { key: "anthropic/claude-opus-4-7", label: "Opus 4.7" },
          { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
        ],
      }),
    ).toBe("openai/gpt-5.6-sol");
  });

  it("uses the current subscription fallback for older catalog payloads", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [
          { key: "openai/gpt-5.4", label: "GPT-5.4" },
          { key: "openai/gpt-5.5", label: "GPT-5.5" },
          { key: "anthropic/claude-sonnet-4-6", label: "Sonnet 4.6" },
        ],
      }),
    ).toBe("openai/gpt-5.6-sol");
  });

  it("reports whether the catalog is still refreshing", async () => {
    const { isModelCatalogRefreshing } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(isModelCatalogRefreshing({ refreshing: true })).toBe(true);
    expect(isModelCatalogRefreshing({ refreshing: false })).toBe(false);
  });

  it("forces a real fetch when preloading the onboarding model catalog", async () => {
    vi.resetModules();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
    });

    const {
      getCached,
      invalidateCache,
      setCached,
    } = await import("../../lib/public/js/lib/api-cache.js");
    const {
      kModelCatalogCacheKey,
      preloadModelCatalog,
    } = await import("../../lib/public/js/lib/model-catalog.js");

    invalidateCache(kModelCatalogCacheKey);
    setCached(kModelCatalogCacheKey, {
      models: [{ key: "fallback/model", label: "Fallback" }],
    });

    const result = await preloadModelCatalog();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/models",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({
      models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
    });
    expect(getCached(kModelCatalogCacheKey)).toEqual(result);
  });
});
