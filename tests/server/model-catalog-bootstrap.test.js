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
      byteplus: "no public catalog; the BytePlus probe needs a real key",
      "byteplus-plan": "no public catalog; the BytePlus probe needs a real key",
      "volcengine-plan": "coding-plan alias of volcengine; the probe needs a real key",
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

  it("lists the major provider-api providers with current public catalogs", () => {
    const providerApi = catalog.accessModes["provider-api"].providers;
    const byId = new Map(providerApi.map((provider) => [provider.id, provider]));
    for (const providerId of ["xai", "google", "groq", "minimax", "moonshot", "mistral"]) {
      const entry = byId.get(providerId);
      expect(entry, providerId).toBeDefined();
      expect(entry.models.length, providerId).toBeGreaterThan(0);
      expect(
        entry.models.some((model) =>
          String(model.source || "").includes("public-provider-catalog"),
        ),
        `${providerId} should carry public-provider-catalog rows`,
      ).toBe(true);
      expect(
        entry.models.every((model) => model.key.startsWith(`${providerId}/`)),
        providerId,
      ).toBe(true);
    }
    expect(byId.get("groq").requiredPlugins).toEqual(["groq"]);
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
