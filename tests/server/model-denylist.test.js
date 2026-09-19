const {
  isDeniedModelKey,
  filterDeniedModels,
  stripDeniedModelsFromCatalog,
} = require("../../lib/server/model-denylist");

describe("server/model-denylist", () => {
  it("denies GPT-5.5 under every provider and gateway prefix", () => {
    for (const key of [
      "openai/gpt-5.5",
      "vercel-ai-gateway/openai/gpt-5.5",
      "vercel-ai-gateway/openai/gpt-5.5-pro",
      "vercel-ai-gateway/openai/gpt-5.5-fast",
      "openrouter/openai/gpt-5.5:batch",
      "openrouter/openai/gpt-5.5-pro:batch",
      "kilocode/openai/gpt-5.5",
      "cloudflare-ai-gateway/openai/gpt-5.5",
      "OPENAI/GPT-5.5",
      "venice/openai-gpt-55",
      "venice/openai-gpt-55-pro",
      "openai/gpt-55",
      "openai-gpt-5.5",
    ]) {
      expect(isDeniedModelKey(key)).toBe(true);
    }
  });

  it("does not deny neighbouring OpenAI models or other providers", () => {
    for (const key of [
      "openai/gpt-5.6",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.55",
      "openai/gpt-5.5.1",
      "openai/gpt-5.1-codex",
      "openai-codex/gpt-5.6",
      "venice/openai-gpt-54-pro",
      "venice/openai-gpt-56",
      "anthropic/claude-opus-4-8",
      "vercel-ai-gateway/anthropic/claude-opus-4.8",
      "",
      null,
    ]) {
      expect(isDeniedModelKey(key)).toBe(false);
    }
  });

  it("filters model entries by key, id, or a GPT-5.5 label", () => {
    expect(
      filterDeniedModels([
        { key: "openai/gpt-5.5" },
        { id: "kilocode/openai/gpt-5.5" },
        { key: "openai/gpt-5.6" },
        { key: "someprovider/alias-1", label: "GPT-5.5" },
        { key: "someprovider/alias-2", name: "GPT-5.5 Pro" },
        { key: "someprovider/alias-3", label: "GPT-5.6 (GPT-5.5 successor)" },
        "openrouter/openai/gpt-5.5",
        "anthropic/claude-sonnet-4-6",
      ]),
    ).toEqual([
      { key: "openai/gpt-5.6" },
      { key: "someprovider/alias-3", label: "GPT-5.6 (GPT-5.5 successor)" },
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("strips denied models from a catalog payload without mutating it", () => {
    const payload = {
      ok: true,
      source: "openclaw",
      models: [
        { key: "vercel-ai-gateway/openai/gpt-5.5", label: "GPT-5.5" },
        { key: "vercel-ai-gateway/anthropic/claude-opus-4.8" },
      ],
      accessModes: {
        subscription: {
          providers: [
            {
              id: "openai",
              recommendedModelKeys: ["openai/gpt-5.5", "openai/gpt-5.6-sol"],
              models: [
                { key: "openai/gpt-5.5" },
                { key: "openai/gpt-5.6-sol" },
              ],
            },
          ],
        },
        gateway: {
          providers: [
            {
              id: "kilocode",
              models: [{ key: "kilocode/openai/gpt-5.5" }],
            },
          ],
        },
        untouched: null,
      },
    };
    const before = JSON.stringify(payload);

    const next = stripDeniedModelsFromCatalog(payload);

    expect(next.models).toEqual([
      { key: "vercel-ai-gateway/anthropic/claude-opus-4.8" },
    ]);
    expect(next.accessModes.subscription.providers[0]).toEqual({
      id: "openai",
      recommendedModelKeys: ["openai/gpt-5.6-sol"],
      models: [{ key: "openai/gpt-5.6-sol" }],
    });
    expect(next.accessModes.gateway.providers[0].models).toEqual([]);
    expect(next.accessModes.untouched).toBeNull();
    expect(next.ok).toBe(true);
    expect(JSON.stringify(payload)).toBe(before);
    expect(stripDeniedModelsFromCatalog(null)).toBeNull();
  });
});
