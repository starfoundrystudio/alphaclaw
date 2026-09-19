const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const kThinkingModuleSentinel = "listThinkingLevelOptions";
const kThinkingSharedModulePattern = /^thinking\.shared-.*\.(?:js|mjs)$/;
const kThinkingSharedModuleSentinel = "function normalizeThinkLevel";

let thinkingModulePromise = null;
let thinkingSharedModulePromise = null;

const resolveOpenclawDistDir = () => path.dirname(require.resolve("openclaw"));

// Several `thinking-*.mjs` chunks mention the sentinel. Prefer the chunk that
// exports `listThinkingLevelOptions` by name: since 2026.9.5 a minified
// sibling chunk is listed first and its single-letter export `i` is no
// longer that function, which made every level id come back empty.
const resolveThinkingModulePaths = (distDir = resolveOpenclawDistDir()) => {
  const candidates = [];
  for (const name of fs.readdirSync(distDir)) {
    if (!/^thinking-.*\.(?:js|mjs)$/.test(name)) continue;
    if (name.includes("api") || name.includes("policy")) continue;
    const fullPath = path.join(distDir, name);
    const source = fs.readFileSync(fullPath, "utf8");
    if (!source.includes(kThinkingModuleSentinel)) continue;
    const namedExport = new RegExp(
      `export\\s*\\{[^}]*\\b${kThinkingModuleSentinel}\\b`,
    ).test(source);
    candidates.push({ fullPath, namedExport });
  }
  if (candidates.length === 0) {
    throw new Error("OpenClaw thinking module not found");
  }
  candidates.sort((left, right) => Number(right.namedExport) - Number(left.namedExport));
  return candidates.map((candidate) => candidate.fullPath);
};

const resolveThinkingModulePath = (distDir = resolveOpenclawDistDir()) =>
  resolveThinkingModulePaths(distDir)[0];

const resolveThinkingSharedModulePath = (distDir = resolveOpenclawDistDir()) => {
  for (const name of fs.readdirSync(distDir)) {
    if (!kThinkingSharedModulePattern.test(name)) continue;
    const fullPath = path.join(distDir, name);
    const source = fs.readFileSync(fullPath, "utf8");
    if (source.includes(kThinkingSharedModuleSentinel)) return fullPath;
  }
  throw new Error("OpenClaw shared thinking module not found");
};

const loadThinkingModule = async () => {
  if (!thinkingModulePromise) {
    thinkingModulePromise = (async () => {
      let fallback = null;
      for (const modulePath of resolveThinkingModulePaths()) {
        const mod = await import(pathToFileURL(modulePath).href);
        if (typeof mod.listThinkingLevelOptions === "function") return mod;
        fallback ??= mod;
      }
      return fallback;
    })();
  }
  return thinkingModulePromise;
};

const loadThinkingSharedModule = async () => {
  if (!thinkingSharedModulePromise) {
    const modulePath = resolveThinkingSharedModulePath();
    thinkingSharedModulePromise = import(pathToFileURL(modulePath).href);
  }
  return thinkingSharedModulePromise;
};

const splitModelKey = (modelKey = "") => {
  const normalized = String(modelKey || "").trim();
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) return { provider: "", model: normalized };
  return {
    provider: normalized.slice(0, slashIndex),
    model: normalized.slice(slashIndex + 1),
  };
};

const buildCatalogEntry = ({ provider, model, reasoning, compat } = {}) => {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(model || "").trim();
  if (!normalizedProvider || !normalizedModel) return null;
  const entry = {
    provider: normalizedProvider,
    id: normalizedModel,
  };
  if (typeof reasoning === "boolean") entry.reasoning = reasoning;
  if (compat && typeof compat === "object") entry.compat = compat;
  return entry;
};

const resolveThinkingApi = async () => {
  const [mod, sharedMod] = await Promise.all([
    loadThinkingModule(),
    loadThinkingSharedModule(),
  ]);
  return {
    listThinkingLevelOptions: mod.listThinkingLevelOptions || mod.i,
    resolveThinkingDefaultForModel: mod.resolveThinkingDefaultForModel || mod.s,
    normalizeThinkLevel:
      mod.normalizeThinkLevel || sharedMod.normalizeThinkLevel || sharedMod.s,
  };
};

const resolveThinkingOptionsForModel = async ({
  modelKey = "",
  catalog = [],
  agentRuntime = "openclaw",
} = {}) => {
  const { provider, model } = splitModelKey(modelKey);
  if (!provider || !model) {
    return {
      levels: [],
      modelDefault: "off",
    };
  }
  const api = await resolveThinkingApi();
  const levels =
    api.listThinkingLevelOptions(provider, model, catalog, agentRuntime) || [];
  const modelDefault =
    api.resolveThinkingDefaultForModel({
      provider,
      model,
      catalog,
    }) || "off";
  return {
    levels: levels.map((entry) => ({
      id: String(entry?.id || "").trim(),
      label: String(entry?.label || entry?.id || "").trim(),
    })),
    modelDefault: String(modelDefault || "off").trim() || "off",
  };
};

const normalizeThinkingDefaultValue = async (raw) => {
  if (raw === null || raw === undefined || raw === "") return null;
  const api = await resolveThinkingApi();
  const normalized = api.normalizeThinkLevel(String(raw || "").trim());
  return normalized || null;
};

module.exports = {
  buildCatalogEntry,
  loadThinkingModule,
  loadThinkingSharedModule,
  normalizeThinkingDefaultValue,
  resolveThinkingOptionsForModel,
  splitModelKey,
};
