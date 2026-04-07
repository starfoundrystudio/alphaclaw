const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const kAlphaclawRoot = path.join(__dirname, "..");

const findProjectRootFromOpenclawDir = (openclawDir) => {
  let dir = path.resolve(openclawDir);
  for (let i = 0; i < 30; i += 1) {
    if (
      fs.existsSync(path.join(dir, "package-lock.json")) ||
      fs.existsSync(path.join(dir, "yarn.lock")) ||
      fs.existsSync(path.join(dir, "pnpm-lock.yaml"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.dirname(openclawDir));
};

const resolveOpenclawDirFromMainPath = (openclawMainPath) => {
  let dir = path.dirname(openclawMainPath);
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "openclaw") return dir;
      } catch {
        /* continue */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.dirname(openclawMainPath));
};

const resolveOpenclawInstallPaths = () => {
  let openclawMainPath;
  try {
    openclawMainPath = require.resolve("openclaw", { paths: [kAlphaclawRoot] });
  } catch {
    return null;
  }

  const openclawDir = resolveOpenclawDirFromMainPath(openclawMainPath);
  return {
    openclawDir,
    openclawMainPath,
    projectRoot: findProjectRootFromOpenclawDir(openclawDir),
  };
};

const runNodeScript = (scriptPath, options = {}) => {
  const { args = [], ...spawnOptions } = options;
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
    ...spawnOptions,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
};

const runOpenclawBundledPluginPostinstall = ({ openclawDir }) => {
  if (!openclawDir) return;
  const scriptPath = path.join(openclawDir, "scripts", "postinstall-bundled-plugins.mjs");
  if (!fs.existsSync(scriptPath)) {
    return;
  }
  runNodeScript(scriptPath, { cwd: openclawDir });
};

module.exports = {
  findProjectRootFromOpenclawDir,
  kAlphaclawRoot,
  resolveOpenclawDirFromMainPath,
  resolveOpenclawInstallPaths,
  runNodeScript,
  runOpenclawBundledPluginPostinstall,
};
