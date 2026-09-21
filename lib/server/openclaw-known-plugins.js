"use strict";

// Plugin ids OpenClaw can actually load on this host: the ones bundled with
// the installed OpenClaw package plus the ones installed into the state dir.
// Read from manifests on disk so callers do not pay for an `openclaw plugins
// list` process (2–7 s on a managed host).
//
// Why it exists: OpenClaw 2026.9 validates `plugins.deny` against known
// plugins and prints "plugins.deny: plugin not found: <id> (stale config
// entry ignored …)" for every unknown id on every config-writing command.
// Denying only known plugins keeps the policy without the warning wall
// (G3 finding #20, Bill 2026-09-21: option 2).

const fs = require("fs");
const path = require("path");

const kManifestFileName = "openclaw.plugin.json";

const readManifestId = (fsModule, manifestPath) => {
  try {
    const manifest = JSON.parse(fsModule.readFileSync(manifestPath, "utf8"));
    const id = String(manifest?.id || "").trim();
    return id || null;
  } catch {
    return null;
  }
};

const listDirs = (fsModule, dir) => {
  try {
    return fsModule
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

// node_modules/<name>/ and node_modules/@scope/<name>/
const listPackageDirs = (fsModule, nodeModulesDir) =>
  listDirs(fsModule, nodeModulesDir).flatMap((dir) =>
    path.basename(dir).startsWith("@") ? listDirs(fsModule, dir) : [dir],
  );

const resolveOpenclawPackageDir = () => {
  try {
    let dir = path.dirname(require.resolve("openclaw"));
    while (dir && dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(dir, "package.json"), "utf8"),
        );
        if (pkg?.name === "openclaw") return dir;
      } catch {}
      dir = path.dirname(dir);
    }
  } catch {}
  return null;
};

const listKnownOpenclawPluginIds = ({
  openclawDir,
  openclawPackageDir = resolveOpenclawPackageDir(),
  fsModule = fs,
} = {}) => {
  const ids = new Set();
  const addFrom = (pluginDir) => {
    const id = readManifestId(fsModule, path.join(pluginDir, kManifestFileName));
    if (id) ids.add(id);
  };

  if (openclawPackageDir) {
    for (const dir of listDirs(fsModule, path.join(openclawPackageDir, "dist", "extensions"))) {
      addFrom(dir);
    }
  }
  if (openclawDir) {
    for (const dir of listDirs(fsModule, path.join(openclawDir, "extensions"))) {
      addFrom(dir);
    }
    for (const projectDir of listDirs(fsModule, path.join(openclawDir, "npm", "projects"))) {
      for (const dir of listPackageDirs(fsModule, path.join(projectDir, "node_modules"))) {
        addFrom(dir);
      }
    }
  }
  return ids;
};

module.exports = {
  listKnownOpenclawPluginIds,
  resolveOpenclawPackageDir,
};
