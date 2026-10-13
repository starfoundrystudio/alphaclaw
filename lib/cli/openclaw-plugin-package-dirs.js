"use strict";

// Where OpenClaw keeps installed plugin packages on disk: npm installs under
// <stateDir>/npm/projects/<project>/node_modules/<package> (2026.9), older
// installs under <stateDir>/extensions/<name>.

const fs = require("fs");
const path = require("path");

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

const findInstalledPackageDirs = ({ fsModule = fs, openclawDir, packageName }) => {
  const parts = packageName.split("/");
  const dirs = [];
  for (const projectDir of listDirs(fsModule, path.join(openclawDir, "npm", "projects"))) {
    const candidate = path.join(projectDir, "node_modules", ...parts);
    if (fsModule.existsSync(path.join(candidate, "package.json"))) dirs.push(candidate);
  }
  const extension = path.join(openclawDir, "extensions", parts[parts.length - 1]);
  if (fsModule.existsSync(path.join(extension, "package.json"))) dirs.push(extension);
  return dirs;
};

const readPackageVersion = (fsModule, packageDir) => {
  try {
    return String(
      JSON.parse(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8"))
        ?.version || "",
    ).trim();
  } catch {
    return "";
  }
};

module.exports = {
  findInstalledPackageDirs,
  readPackageVersion,
};
