"use strict";

// Installs the TeamYou memory plugin from an archive clawctl stages on the
// host. On OpenClaw 2026.9 a plugin install while the Gateway runs is handed
// to the Gateway (`plugins.install` RPC), and our Gateway runs with
// OPENCLAW_CONFIG_READONLY=1, so it refuses. Clawbridge's startup plugin
// reconcile runs before the Gateway starts, which makes it the one place the
// install can succeed without an extra Gateway restart (G3 finding #17).
//
// clawctl hands over three values in Clawbridge's .env:
//   ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_ARCHIVE  local .tgz path, readable by the app user
//   ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_VERSION  plugin version in that archive
//   ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_URL      artifact URL the archive came from
// The install marker keeps clawctl's format and path so both sides agree on
// what is installed.

const path = require("path");

const kTeamyouMemoryPluginId = "openclaw-teamyou-memory";
const kArchiveEnv = "ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_ARCHIVE";
const kVersionEnv = "ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_VERSION";
const kUrlEnv = "ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_URL";
const kMarkerFileName = ".clawctl-managed-openclaw-teamyou-memory.env";

const getMarkerPath = ({ openclawDir }) =>
  path.join(openclawDir, "plugins", kMarkerFileName);

const getPluginManifestPath = ({ openclawDir }) =>
  path.join(openclawDir, "extensions", kTeamyouMemoryPluginId, "openclaw.plugin.json");

// Reads KEY=value lines written either by bash `printf %q` (clawctl) or with
// single quotes (this module). Only the forms those two writers produce.
const unquoteShellValue = (raw) => {
  const value = String(raw ?? "").trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value.replace(/\\(.)/g, "$1");
};

const parseShellAssignments = (text) => {
  const result = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = unquoteShellValue(match[2]);
  }
  return result;
};

const quoteShellValue = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const readMarker = ({ fsModule, openclawDir }) => {
  try {
    return parseShellAssignments(
      fsModule.readFileSync(getMarkerPath({ openclawDir }), "utf8"),
    );
  } catch {
    return {};
  }
};

const writeMarker = ({ fsModule, openclawDir, version, url }) => {
  const markerPath = getMarkerPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(markerPath), { recursive: true });
  fsModule.writeFileSync(
    markerPath,
    [
      `INSTALLED_TEAMYOU_MEMORY_PLUGIN_VERSION=${quoteShellValue(version)}`,
      `INSTALLED_TEAMYOU_MEMORY_PLUGIN_URL=${quoteShellValue(url)}`,
      "",
    ].join("\n"),
  );
};

const isPluginInstalled = ({ fsModule, openclawDir }) => {
  try {
    const manifest = JSON.parse(
      fsModule.readFileSync(getPluginManifestPath({ openclawDir }), "utf8"),
    );
    return String(manifest?.id || "").trim() === kTeamyouMemoryPluginId;
  } catch {
    return false;
  }
};

const readHandoff = (env = process.env) => ({
  archivePath: String(env[kArchiveEnv] || "").trim(),
  version: String(env[kVersionEnv] || "").trim(),
  url: String(env[kUrlEnv] || "").trim(),
});

const reconcileTeamyouMemoryPlugin = ({
  openclawDir,
  env = process.env,
  fsModule,
  runOpenclaw,
  logger = console,
}) => {
  const { archivePath, version, url } = readHandoff(env);
  if (!archivePath || !version) {
    return { id: kTeamyouMemoryPluginId, action: "skipped", reason: "not_configured" };
  }

  const marker = readMarker({ fsModule, openclawDir });
  const installed = isPluginInstalled({ fsModule, openclawDir });
  if (
    installed &&
    marker.INSTALLED_TEAMYOU_MEMORY_PLUGIN_VERSION === version &&
    (!url || marker.INSTALLED_TEAMYOU_MEMORY_PLUGIN_URL === url)
  ) {
    logger.log(
      `[alphaclaw] Skipping ${kTeamyouMemoryPluginId}: ${version} already installed`,
    );
    return { id: kTeamyouMemoryPluginId, version, action: "skipped", reason: "already_installed" };
  }

  if (!/\.tgz$/i.test(archivePath)) {
    throw new Error(`${kArchiveEnv} must point to a .tgz archive: ${archivePath}`);
  }
  if (!fsModule.existsSync(archivePath)) {
    throw new Error(
      `TeamYou memory plugin archive is missing at ${archivePath}; clawctl stages it during host setup`,
    );
  }

  const action = installed ? "updated" : "installed";
  logger.log(
    `[alphaclaw] ${installed ? "Updating" : "Installing"} ${kTeamyouMemoryPluginId}: ${version} from ${archivePath}`,
  );
  // --force: 2026.9 cancels archive installs outside ClawHub review without it
  // and it also replaces an existing extension directory.
  // --accept-capabilities: consent is mandatory; the archive is our own.
  // No --pin: 2026.9 rejects it for non-registry installs, and the archive is
  // already one exact version.
  runOpenclaw([
    "plugins",
    "install",
    archivePath,
    "--force",
    "--accept-capabilities",
  ]);

  if (!isPluginInstalled({ fsModule, openclawDir })) {
    throw new Error(
      `OpenClaw did not install ${kTeamyouMemoryPluginId} from ${archivePath}`,
    );
  }
  writeMarker({ fsModule, openclawDir, version, url });
  return { id: kTeamyouMemoryPluginId, version, action };
};

module.exports = {
  kTeamyouMemoryPluginId,
  kTeamyouMemoryPluginArchiveEnv: kArchiveEnv,
  kTeamyouMemoryPluginVersionEnv: kVersionEnv,
  kTeamyouMemoryPluginUrlEnv: kUrlEnv,
  getMarkerPath,
  parseShellAssignments,
  readMarker,
  reconcileTeamyouMemoryPlugin,
};
