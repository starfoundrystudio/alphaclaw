import fs from "node:fs";
import path from "node:path";

const kRepoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const kManifestPath = path.join(
  kRepoRoot,
  "lib",
  "openclaw-compatibility.manifest.json",
);
const kCatalogs = [
  {
    kind: "channel",
    file: "scripts/lib/official-external-channel-catalog.json",
  },
  {
    kind: "plugin",
    file: "scripts/lib/official-external-plugin-catalog.json",
  },
  {
    kind: "provider",
    file: "scripts/lib/official-external-provider-catalog.json",
  },
];
const kOpenclawGitHubRawBase = "https://raw.githubusercontent.com/openclaw/openclaw";

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const fetchGitHubJson = async ({ gitRef, file }) => {
  const url = `${kOpenclawGitHubRawBase}/${gitRef}/${file}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "alphaclaw-openclaw-compatibility-manifest-generator",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenClaw catalog ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
};

const splitNpmSpec = (npmSpec) => {
  const value = String(npmSpec || "").replace(/^npm:/, "");
  const atIndex = value.lastIndexOf("@");
  const slashIndex = value.lastIndexOf("/");
  if (atIndex > 0 && atIndex > slashIndex) {
    return {
      packageName: value.slice(0, atIndex),
      version: value.slice(atIndex + 1),
    };
  }
  return {
    packageName: value,
    version: "",
  };
};

const uniqueStrings = (values = []) =>
  [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];

const normalizeContracts = (contracts = {}) => {
  const normalized = {};
  for (const [key, value] of Object.entries(contracts || {})) {
    const ids = uniqueStrings(Array.isArray(value) ? value : []);
    if (ids.length > 0) normalized[key] = ids;
  }
  return normalized;
};

const buildManagedPluginEntry = ({ catalogKind, entry, openclawVersion }) => {
  const openclaw = entry.openclaw || {};
  const pluginId =
    openclaw.plugin?.id ||
    openclaw.channel?.id ||
    openclaw.providers?.[0]?.id ||
    entry.name;
  const channelId = openclaw.channel?.id;
  const providerIds = uniqueStrings(
    (openclaw.providers || []).map((provider) => provider.id),
  );
  const providerAliases = uniqueStrings(
    (openclaw.providers || []).flatMap((provider) => provider.aliases || []),
  );
  const webSearchProviderIds = uniqueStrings(
    (openclaw.webSearchProviders || []).map((provider) => provider.id),
  );
  const contracts = normalizeContracts(openclaw.contracts);
  const npmSpec = openclaw.install?.npmSpec || entry.name;
  const { packageName, version: explicitVersion } = splitNpmSpec(npmSpec);
  const version = explicitVersion || openclawVersion;

  return [
    pluginId,
    {
      kind: catalogKind,
      package: packageName,
      version,
      pluginId,
      ...(channelId ? { channelId } : {}),
      ...(providerIds.length > 0 ? { providerIds } : {}),
      ...(providerAliases.length > 0 ? { providerAliases } : {}),
      ...(webSearchProviderIds.length > 0 ? { webSearchProviderIds } : {}),
      ...(Object.keys(contracts).length > 0 ? { contracts } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      source: entry.source || "official",
      install: {
        npmSpec: packageName,
        exactNpmSpec: `${packageName}@${version}`,
        ...(openclaw.install?.defaultChoice
          ? { defaultChoice: openclaw.install.defaultChoice }
          : {}),
        ...(openclaw.install?.minHostVersion
          ? { minHostVersion: openclaw.install.minHostVersion }
          : {}),
      },
    },
  ];
};

const resolvePinnedOpenclawVersion = (packageJson) => {
  const version =
    packageJson.dependencies?.openclaw || packageJson.devDependencies?.openclaw;
  if (!version) {
    throw new Error("package.json does not declare a pinned openclaw dependency");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `OpenClaw dependency must be an exact version for manifest generation: ${version}`,
    );
  }
  return version;
};

const generateManifest = async () => {
  const packageJson = readJson(path.join(kRepoRoot, "package.json"));
  const openclawVersion = resolvePinnedOpenclawVersion(packageJson);
  const openclawGitRef = `v${openclawVersion}`;
  const managedPlugins = {};

  for (const catalog of kCatalogs) {
    const catalogJson = await fetchGitHubJson({
      gitRef: openclawGitRef,
      file: catalog.file,
    });
    for (const entry of catalogJson.entries || []) {
      const [key, value] = buildManagedPluginEntry({
        catalogKind: catalog.kind,
        entry,
        openclawVersion,
      });
      managedPlugins[key] = value;
    }
  }

  return {
    schemaVersion: 1,
    alphaclawVersion: packageJson.version,
    openclawVersion,
    source: {
      openclawPackage: "openclaw",
      openclawGitRef,
      upstreamCatalogs: kCatalogs.map((catalog) => ({
        kind: catalog.kind,
        path: catalog.file,
        url: `https://github.com/openclaw/openclaw/blob/${openclawGitRef}/${catalog.file}`,
      })),
    },
    managedPlugins,
  };
};

const manifest = await generateManifest();
fs.mkdirSync(path.dirname(kManifestPath), { recursive: true });
fs.writeFileSync(kManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Generated ${path.relative(kRepoRoot, kManifestPath)} with ${Object.keys(manifest.managedPlugins).length} official OpenClaw plugins`,
);
