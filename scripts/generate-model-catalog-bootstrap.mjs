import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const kRepoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const requireFromRepo = createRequire(path.join(kRepoRoot, "package.json"));
const kSupportSpecPath = path.join(
  kRepoRoot,
  "lib",
  "server",
  "model-catalog-support.json",
);
const kCompatibilityManifestPath = path.join(
  kRepoRoot,
  "lib",
  "openclaw-compatibility.manifest.json",
);
const kBootstrapPath = path.join(
  kRepoRoot,
  "lib",
  "server",
  "model-catalog-bootstrap.json",
);
const kPublicModelCatalogTimeoutMs = 20_000;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const normalizeString = (value) => String(value || "").trim();

const uniqueStrings = (values = []) =>
  [...new Set(values.map(normalizeString).filter(Boolean))];

const getProviderFromKey = (key) => normalizeString(key).split("/")[0] || "";

const getAllowedModelKeysForAccessMode = ({ providerMeta, accessMode }) => {
  const scopedKeys = providerMeta?.allowedModelKeysByAccessMode?.[accessMode];
  return uniqueStrings(
    scopedKeys === undefined ? providerMeta?.allowedModelKeys || [] : scopedKeys,
  );
};

const getRecommendedModelKeysForAccessMode = ({ providerMeta, accessMode }) => {
  const scopedKeys = providerMeta?.recommendedModelKeysByAccessMode?.[accessMode];
  return uniqueStrings(
    scopedKeys === undefined ? providerMeta?.recommendedModelKeys || [] : scopedKeys,
  );
};

const getModelAccessModes = ({ key, providerMeta }) =>
  uniqueStrings(providerMeta?.accessModes || []).filter((accessMode) => {
    const allowedModelKeys = getAllowedModelKeysForAccessMode({
      providerMeta,
      accessMode,
    });
    return allowedModelKeys.length === 0 || allowedModelKeys.includes(key);
  });

const getOpenclawCliPath = () => {
  let packageDir = path.dirname(requireFromRepo.resolve("openclaw"));
  while (packageDir && packageDir !== path.dirname(packageDir)) {
    const candidatePath = path.join(packageDir, "package.json");
    try {
      const candidate = readJson(candidatePath);
      if (candidate.name === "openclaw") break;
    } catch {}
    packageDir = path.dirname(packageDir);
  }
  const packagePath = path.join(packageDir, "package.json");
  const packageJson = readJson(packagePath);
  const binPath =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.openclaw || "openclaw.mjs";
  return path.join(path.dirname(packagePath), binPath);
};

const parseOpenclawVersion = (rawOutput) => {
  const text = String(rawOutput || "").trim();
  const match = text.match(/\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?(?:\s+\([^)]+\))?/);
  return match ? match[0] : text;
};

const buildProbeEnv = ({ tempRoot }) => ({
  ...process.env,
  HOME: tempRoot,
  OPENCLAW_HOME: tempRoot,
  OPENCLAW_STATE_DIR: path.join(tempRoot, ".openclaw"),
  OPENCLAW_CONFIG_PATH: path.join(tempRoot, ".openclaw", "openclaw.json"),
  XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
  NO_COLOR: "1",
});

const runOpenclaw = ({ args, env, openclawCliPath }) =>
  execFileSync(process.execPath, [openclawCliPath, ...args], {
    cwd: kRepoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });

const normalizeProbeModel = ({ provider, rawModel, providerMeta }) => {
  const rawKey = normalizeString(rawModel?.key);
  const rawId = normalizeString(rawModel?.id);
  const key = rawKey || (rawId ? `${provider}/${rawId}` : "");
  if (!key || !key.includes("/")) return null;
  const normalizedProvider =
    getProviderFromKey(key) || normalizeString(rawModel?.provider) || provider;
  const label =
    normalizeString(rawModel?.label) ||
    normalizeString(rawModel?.name) ||
    normalizeString(rawModel?.title) ||
    rawId ||
    key;
  const accessModes = getModelAccessModes({ key, providerMeta });
  if (accessModes.length === 0) return null;
  return {
    key,
    provider: normalizedProvider,
    label,
    accessModes,
    source: "openclaw-provider-probe",
  };
};

const normalizePublicCatalogModel = ({ provider, rawModel, providerMeta }) => {
  const rawId = normalizeString(rawModel?.id);
  if (!rawId) return null;
  const key = `${provider}/${rawId}`;
  const accessModes = getModelAccessModes({ key, providerMeta });
  if (accessModes.length === 0) return null;
  return {
    key,
    provider,
    label: normalizeString(rawModel?.name) || rawId,
    accessModes,
    source: "public-provider-catalog",
  };
};

const normalizeExplicitModel = ({ rawModel, providers }) => {
  const key = normalizeString(rawModel?.key);
  if (!key || !key.includes("/")) {
    throw new Error(`Explicit model is missing a valid key: ${JSON.stringify(rawModel)}`);
  }
  const provider = normalizeString(rawModel.provider) || getProviderFromKey(key);
  const providerMeta = providers[provider] || {};
  const accessModes = uniqueStrings(rawModel.accessModes || providerMeta.accessModes || []);
  const recommendation = normalizeString(rawModel.recommendation);
  return {
    key,
    provider,
    label: normalizeString(rawModel.label) || key,
    accessModes,
    ...(rawModel.accessLabel ? { accessLabel: normalizeString(rawModel.accessLabel) } : {}),
    ...(recommendation
      ? { recommendation, recommendedAccessModes: accessModes }
      : {}),
    source: "alphaclaw-support-spec",
  };
};

const fetchPublicProviderModels = async ({ provider, providerMeta }) => {
  const publicCatalog = providerMeta?.publicModelCatalog;
  if (!publicCatalog) return [];
  const endpoint = normalizeString(publicCatalog.endpoint);
  const minimumModelCount = Number(publicCatalog.minimumModelCount || 0);
  const modelTypes = new Set(uniqueStrings(publicCatalog.modelTypes || []));
  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        "user-agent": "AlphaClaw-model-catalog-generator",
      },
      signal: AbortSignal.timeout(kPublicModelCatalogTimeoutMs),
    });
  } catch (error) {
    throw new Error(`Failed to fetch public model catalog for ${provider}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch public model catalog for ${provider}: HTTP ${response.status}`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `Failed to parse public model catalog for ${provider}: ${error.message}`,
    );
  }
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .filter(
      (rawModel) =>
        modelTypes.size === 0 || modelTypes.has(normalizeString(rawModel?.type)),
    )
    .map((rawModel) => normalizePublicCatalogModel({ provider, rawModel, providerMeta }))
    .filter(Boolean);
  if (models.length < minimumModelCount) {
    throw new Error(
      `Public model catalog for ${provider} returned ${models.length} models; expected at least ${minimumModelCount}`,
    );
  }
  return models;
};

const listProviderModels = ({ provider, providerMeta, env, openclawCliPath }) => {
  const minimumProbeModelCount = Number(providerMeta.minimumProbeModelCount || 0);
  const validateMinimumProbeModelCount = (models) => {
    if (models.length < minimumProbeModelCount) {
      throw new Error(
        `OpenClaw model probe for ${provider} returned ${models.length} models; expected at least ${minimumProbeModelCount}`,
      );
    }
    return models;
  };
  let output = "";
  try {
    output = runOpenclaw({
      args: ["models", "list", "--provider", provider, "--all", "--json"],
      env,
      openclawCliPath,
    });
  } catch (error) {
    const text = [error?.stdout, error?.stderr, error?.message]
      .filter(Boolean)
      .map(String)
      .join("\n");
    if (/No models found/i.test(text)) return validateMinimumProbeModelCount([]);
    throw new Error(`Failed to probe OpenClaw models for ${provider}: ${text}`);
  }
  let payload;
  try {
    if (/^\s*No models found\.?\s*$/i.test(output)) {
      return validateMinimumProbeModelCount([]);
    }
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Failed to parse OpenClaw model probe JSON for ${provider}: ${error.message}`,
    );
  }
  const models = (Array.isArray(payload.models) ? payload.models : [])
    .map((rawModel) =>
      normalizeProbeModel({
        provider,
        rawModel,
        providerMeta,
      }),
    )
    .filter(Boolean);
  return validateMinimumProbeModelCount(models);
};

const mergeModel = ({ modelsByKey, model }) => {
  const existing = modelsByKey.get(model.key);
  modelsByKey.set(model.key, {
    ...(existing || {}),
    ...model,
    accessModes: uniqueStrings([
      ...(existing?.accessModes || []),
      ...(model.accessModes || []),
    ]),
    ...((existing?.recommendedAccessModes || model.recommendedAccessModes)
      ? {
          recommendedAccessModes: uniqueStrings([
            ...(existing?.recommendedAccessModes || []),
            ...(model.recommendedAccessModes || []),
          ]),
        }
      : {}),
    source: existing?.source
      ? uniqueStrings([existing.source, model.source]).join("+")
      : model.source,
  });
};

const applyRecommendationMetadata = ({ modelsByKey, providers }) => {
  for (const [key, model] of modelsByKey.entries()) {
    const providerMeta = providers[model.provider] || {};
    const configuredRecommendedAccessModes = uniqueStrings(
      providerMeta.accessModes || [],
    ).filter((accessMode) =>
      getRecommendedModelKeysForAccessMode({ providerMeta, accessMode }).includes(key),
    );
    const recommendedAccessModes = uniqueStrings([
      ...(model.recommendedAccessModes || []),
      ...configuredRecommendedAccessModes,
    ]).filter((accessMode) => model.accessModes.includes(accessMode));
    if (recommendedAccessModes.length === 0) continue;
    modelsByKey.set(key, {
      ...model,
      recommendation: "recommended",
      recommendedAccessModes,
    });
  }
};

const getRequiredPlugins = ({ providerMeta, accessMode }) =>
  uniqueStrings([
    ...(providerMeta?.requiredPlugins || []),
    ...(providerMeta?.requiredPluginsByAccessMode?.[accessMode] || []),
  ]);

const validateSupportSpec = ({ supportSpec, manifest }) => {
  if (supportSpec.schemaVersion !== 1) {
    throw new Error(`Unsupported model catalog support schema: ${supportSpec.schemaVersion}`);
  }
  const managedPlugins = manifest.managedPlugins || {};
  for (const [providerId, providerMeta] of Object.entries(supportSpec.providers || {})) {
    if (providerMeta.publicModelCatalog) {
      const endpoint = normalizeString(providerMeta.publicModelCatalog.endpoint);
      if (!endpoint.startsWith("https://")) {
        throw new Error(`Provider ${providerId} has an invalid public model catalog endpoint`);
      }
      const minimumModelCount = Number(
        providerMeta.publicModelCatalog.minimumModelCount || 0,
      );
      if (!Number.isSafeInteger(minimumModelCount) || minimumModelCount < 1) {
        throw new Error(
          `Provider ${providerId} must declare a positive public model catalog minimum`,
        );
      }
    }
    const requiredPluginGroups = [
      providerMeta.requiredPlugins || [],
      ...Object.values(providerMeta.requiredPluginsByAccessMode || {}),
    ];
    for (const pluginId of uniqueStrings(requiredPluginGroups.flat())) {
      if (!managedPlugins[pluginId]) {
        throw new Error(
          `Provider ${providerId} requires unknown managed OpenClaw plugin: ${pluginId}`,
        );
      }
    }
  }
};

const installProbePlugins = ({ supportSpec, manifest, env, openclawCliPath }) => {
  const managedPlugins = manifest.managedPlugins || {};
  const pluginIds = uniqueStrings(
    uniqueStrings(supportSpec.providerProbes || []).flatMap(
      (providerId) => supportSpec.providers?.[providerId]?.requiredPlugins || [],
    ),
  );
  for (const pluginId of pluginIds) {
    const definition = managedPlugins[pluginId];
    if (!definition) {
      throw new Error(`Cannot install unknown model probe plugin: ${pluginId}`);
    }
    const exactNpmSpec = normalizeString(definition.install?.exactNpmSpec);
    if (!exactNpmSpec) {
      throw new Error(`Model probe plugin ${pluginId} is missing an exact npm spec`);
    }
    runOpenclaw({
      args: ["plugins", "install", `npm:${exactNpmSpec}`, "--pin"],
      env,
      openclawCliPath,
    });
  }
};

const getAuthRoute = ({ providerMeta, accessMode }) =>
  normalizeString(providerMeta.authRoutes?.[accessMode]) ||
  normalizeString(providerMeta.authRoute);

const getRuntimeId = ({ providerMeta, accessMode }) =>
  normalizeString(providerMeta.runtimeIds?.[accessMode]) ||
  normalizeString(providerMeta.runtimeId);

const buildSegmentedAccessModes = ({ supportSpec, models }) => {
  const modelsByProvider = new Map();
  for (const model of models) {
    if (!modelsByProvider.has(model.provider)) modelsByProvider.set(model.provider, []);
    modelsByProvider.get(model.provider).push(model);
  }

  const accessModes = {};
  for (const [accessMode, accessModeMeta] of Object.entries(
    supportSpec.accessModes || {},
  )) {
    const providers = [];
    for (const [providerId, providerMeta] of Object.entries(supportSpec.providers || {})) {
      if (!(providerMeta.accessModes || []).includes(accessMode)) continue;
      const providerModels = (modelsByProvider.get(providerId) || []).filter((model) =>
        (model.accessModes || []).includes(accessMode),
      );
      if (providerModels.length === 0) continue;
      const recommendedModelKeys = getRecommendedModelKeysForAccessMode({
        providerMeta,
        accessMode,
      });
      const recommendedKeys = new Set(recommendedModelKeys);
      const sortedModels = [...providerModels].sort((left, right) => {
        const leftRecommended = recommendedKeys.has(left.key) || left.recommendation === "recommended";
        const rightRecommended =
          recommendedKeys.has(right.key) || right.recommendation === "recommended";
        if (leftRecommended !== rightRecommended) return leftRecommended ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
      providers.push({
        id: providerId,
        label: normalizeString(providerMeta.label) || providerId,
        accessMode,
        authRoute: getAuthRoute({ providerMeta, accessMode }),
        ...(getRuntimeId({ providerMeta, accessMode })
          ? { runtimeId: getRuntimeId({ providerMeta, accessMode }) }
          : {}),
        envKeys: uniqueStrings(providerMeta.envKeys || []),
        requiredPlugins: getRequiredPlugins({ providerMeta, accessMode }),
        recommendedModelKeys,
        models: sortedModels,
      });
    }
    accessModes[accessMode] = {
      id: accessMode,
      ...accessModeMeta,
      providers,
    };
  }
  return accessModes;
};

const generateCatalog = async () => {
  const supportSpec = readJson(kSupportSpecPath);
  const manifest = readJson(kCompatibilityManifestPath);
  validateSupportSpec({ supportSpec, manifest });

  const openclawCliPath = getOpenclawCliPath();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-model-catalog-"));
  const env = buildProbeEnv({ tempRoot });
  let openclawVersion = manifest.openclawVersion;
  const modelsByKey = new Map();

  try {
    openclawVersion = parseOpenclawVersion(
      runOpenclaw({ args: ["--version"], env, openclawCliPath }),
    );
    installProbePlugins({
      supportSpec,
      manifest,
      env,
      openclawCliPath,
    });

    for (const provider of uniqueStrings(supportSpec.providerProbes || [])) {
      const providerMeta = supportSpec.providers?.[provider] || {};
      const models = listProviderModels({
        provider,
        providerMeta,
        env,
        openclawCliPath,
      });
      for (const model of models) mergeModel({ modelsByKey, model });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  for (const [provider, providerMeta] of Object.entries(supportSpec.providers || {})) {
    const models = await fetchPublicProviderModels({ provider, providerMeta });
    for (const model of models) mergeModel({ modelsByKey, model });
  }

  for (const rawModel of supportSpec.explicitModels || []) {
    mergeModel({
      modelsByKey,
      model: normalizeExplicitModel({
        rawModel,
        providers: supportSpec.providers || {},
      }),
    });
  }
  applyRecommendationMetadata({
    modelsByKey,
    providers: supportSpec.providers || {},
  });

  const models = [...modelsByKey.values()].sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare !== 0) return providerCompare;
    return left.label.localeCompare(right.label);
  });

  return {
    schemaVersion: 2,
    version: 2,
    source: "alphaclaw model-catalog-support.json",
    generatedAt: new Date().toISOString(),
    openclawVersion,
    supportSpec: {
      path: "lib/server/model-catalog-support.json",
      schemaVersion: supportSpec.schemaVersion,
    },
    compatibilityManifest: {
      path: "lib/openclaw-compatibility.manifest.json",
      openclawVersion: manifest.openclawVersion,
    },
    accessModes: buildSegmentedAccessModes({ supportSpec, models }),
    models,
  };
};

const catalog = await generateCatalog();
fs.writeFileSync(kBootstrapPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(
  `Generated ${path.relative(kRepoRoot, kBootstrapPath)} with ${catalog.models.length} models across ${Object.keys(catalog.accessModes).length} access modes`,
);
