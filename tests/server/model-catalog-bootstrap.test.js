const fs = require("fs");
const path = require("path");

const kRepoRoot = path.resolve(__dirname, "../..");

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(kRepoRoot, relativePath), "utf8"));

describe("generated model catalog bootstrap", () => {
  const packageJson = readJson("package.json");
  const supportSpec = readJson("lib/server/model-catalog-support.json");
  const manifest = readJson("lib/openclaw-compatibility.manifest.json");
  const catalog = readJson("lib/server/model-catalog-bootstrap.json");

  it("declares the managed plugin required by every external provider probe", () => {
    for (const providerId of supportSpec.providerProbes) {
      const ownerPluginIds = Object.entries(manifest.managedPlugins)
        .filter(([, definition]) =>
          [...(definition.providerIds || []), ...(definition.providerAliases || [])].includes(
            providerId,
          ),
        )
        .map(([pluginId]) => pluginId);
      if (ownerPluginIds.length === 0) continue;

      expect(supportSpec.providers[providerId].requiredPlugins).toEqual(
        expect.arrayContaining(ownerPluginIds),
      );
    }
  });

  it("retains the minimum model set for guarded provider probes", () => {
    expect(catalog.compatibilityManifest.openclawVersion).toBe(
      packageJson.dependencies.openclaw,
    );
    expect(catalog.openclawVersion).toMatch(
      new RegExp(`^${packageJson.dependencies.openclaw.replaceAll(".", "\\.")}(?:\\s|$)`),
    );

    for (const [providerId, providerMeta] of Object.entries(supportSpec.providers)) {
      const minimumProbeModelCount = Number(providerMeta.minimumProbeModelCount || 0);
      if (minimumProbeModelCount === 0) continue;
      const retainedModels = catalog.models.filter(
        (model) => model.provider === providerId,
      );
      expect(retainedModels.length).toBeGreaterThanOrEqual(
        minimumProbeModelCount,
      );
    }
  });

  it("retains the minimum model set for public provider catalogs", () => {
    for (const [providerId, providerMeta] of Object.entries(supportSpec.providers)) {
      const minimumModelCount = Number(
        providerMeta.publicModelCatalog?.minimumModelCount || 0,
      );
      if (minimumModelCount === 0) continue;
      const publicModels = catalog.models.filter(
        (model) =>
          model.provider === providerId &&
          String(model.source || "").includes("public-provider-catalog"),
      );
      expect(publicModels.length).toBeGreaterThanOrEqual(minimumModelCount);
    }
  });

  it("offers at least one model for every provider on every access mode it declares", () => {
    // A declared provider with no models is invisible in Add Model, which is
    // how xAI, Google, Groq and MiniMax went missing and how Cloudflare AI
    // Gateway lost its only row to the GPT-5.5 denylist. Providers that
    // genuinely cannot be enumerated key-free are excluded with a reason.
    const excluded = {
      // (none today; add "provider-id": "reason" when a provider ships no
      // bundled catalog in the pinned OpenClaw release and nothing is pinned
      // for it in explicitModels)
    };
    const missing = [];
    for (const [providerId, providerMeta] of Object.entries(supportSpec.providers)) {
      if (excluded[providerId]) continue;
      for (const accessMode of providerMeta.accessModes || []) {
        const entry = (catalog.accessModes?.[accessMode]?.providers || []).find(
          (provider) => provider.id === providerId,
        );
        if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) {
          missing.push(`${providerId}:${accessMode}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("lists the major provider-api providers from the pinned OpenClaw catalogs", () => {
    const providerApi = catalog.accessModes["provider-api"].providers;
    const byId = new Map(providerApi.map((provider) => [provider.id, provider]));
    // These come from the pinned OpenClaw release itself: the catalog bundled
    // in its core extension or provider plugin manifest, or the CLI probe
    // without a real key; never from a prior bootstrap or an external site.
    for (const providerId of ["xai", "google", "groq", "minimax", "moonshot", "mistral", "deepseek"]) {
      const entry = byId.get(providerId);
      expect(entry, providerId).toBeDefined();
      expect(entry.models.length, providerId).toBeGreaterThan(0);
      expect(
        entry.models.every(
          (model) =>
            model.key.startsWith(`${providerId}/`) &&
            /openclaw-(provider-probe|bundled-catalog)/.test(String(model.source || "")),
        ),
        `${providerId} rows should all come from the pinned OpenClaw release`,
      ).toBe(true);
    }
    for (const providerId of ["moonshot", "deepseek", "groq"]) {
      expect(
        byId.get(providerId).models.some((model) =>
          String(model.source || "").includes("openclaw-bundled-catalog"),
        ),
        `${providerId} should carry rows from the plugin's bundled catalog`,
      ).toBe(true);
    }
    expect(byId.get("minimax").models[0]).toMatchObject({
      key: "minimax/MiniMax-M3",
      recommendation: "recommended",
    });
    expect(byId.get("groq").requiredPlugins).toEqual(["groq"]);
  });

  it("never carries rows forward from a prior bootstrap", () => {
    // Every row must trace to the pinned OpenClaw catalogs, a declared public
    // endpoint, or an explicit spec pin; a "prior-bootstrap-fallback" source
    // means a probe silently went stale.
    const carried = catalog.models
      .filter((model) => String(model.source || "").includes("prior-bootstrap-fallback"))
      .map((model) => model.key);
    expect(carried).toEqual([]);
  });

  it("never lists a provider with an empty model list", () => {
    for (const [accessMode, group] of Object.entries(catalog.accessModes)) {
      for (const provider of group.providers) {
        expect(provider.models.length, `${accessMode}/${provider.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("lists GPT-5.6 variants on the OpenAI routes that support them", () => {
    const modelsByKey = new Map(catalog.models.map((model) => [model.key, model]));

    expect(modelsByKey.get("openai/gpt-5.6")).toMatchObject({
      accessModes: ["provider-api"],
      recommendation: "recommended",
      recommendedAccessModes: ["provider-api"],
    });
    expect(modelsByKey.get("openai/gpt-5.6-sol")).toMatchObject({
      accessModes: ["subscription", "provider-api"],
      recommendation: "recommended",
      recommendedAccessModes: ["subscription"],
    });
    expect(modelsByKey.get("openai/gpt-5.6-terra")?.accessModes).toEqual([
      "subscription",
      "provider-api",
    ]);
    expect(modelsByKey.get("openai/gpt-5.6-luna")?.accessModes).toEqual([
      "subscription",
      "provider-api",
    ]);
  });

  it("includes the public GPT-5.6 gateway variants without non-language Vercel rows", () => {
    const modelKeys = new Set(catalog.models.map((model) => model.key));

    for (const provider of ["openrouter", "vercel-ai-gateway"]) {
      for (const variant of ["sol", "terra", "luna"]) {
        expect(modelKeys.has(`${provider}/openai/gpt-5.6-${variant}`)).toBe(true);
      }
    }
    expect(modelKeys.has("vercel-ai-gateway/openai/gpt-image-1")).toBe(false);
  });
});
