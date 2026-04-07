/**
 * patch-package resolves paths relative to the npm/yarn project root (where the
 * lockfile lives). When this package's postinstall runs, process.cwd() is often
 * this package directory, so a plain `patch-package` call treats that as the
 * app root and looks for ./node_modules/openclaw under it — but openclaw is
 * usually hoisted to the consumer's top-level node_modules.
 *
 * This script finds the real install root (directory containing a lockfile) and
 * runs patch-package there with --patch-dir pointing at our bundled patches/.
 */
const fs = require("fs");
const path = require("path");
const {
  kAlphaclawRoot,
  resolveOpenclawInstallPaths,
  runNodeScript,
  runOpenclawBundledPluginPostinstall,
} = require("./openclaw-install-utils");

const main = () => {
  const patchesDir = path.join(kAlphaclawRoot, "patches");
  if (!fs.existsSync(patchesDir)) {
    return;
  }
  const hasPatch = fs
    .readdirSync(patchesDir)
    .some((name) => name.endsWith(".patch"));
  if (!hasPatch) {
    return;
  }

  const installPaths = resolveOpenclawInstallPaths();
  if (!installPaths) {
    return;
  }
  const { openclawDir, projectRoot } = installPaths;

  let relPatchDir = path.relative(projectRoot, patchesDir);
  if (relPatchDir.startsWith("..") || path.isAbsolute(relPatchDir)) {
    console.error(
      "[@chrysb/alphaclaw] patch-package: could not resolve patch dir relative to project root",
    );
    process.exit(1);
  }
  relPatchDir = relPatchDir.split(path.sep).join("/");

  const patchPackageMain = require.resolve("patch-package/dist/index.js", {
    paths: [kAlphaclawRoot],
  });

  runNodeScript(patchPackageMain, {
    args: ["--patch-dir", relPatchDir],
    cwd: projectRoot,
  });
  runOpenclawBundledPluginPostinstall({ openclawDir });
};

main();
