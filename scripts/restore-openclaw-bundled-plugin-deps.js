const {
  resolveOpenclawInstallPaths,
  runOpenclawBundledPluginPostinstall,
} = require("./openclaw-install-utils");

const main = () => {
  const installPaths = resolveOpenclawInstallPaths();
  if (!installPaths) {
    return;
  }
  runOpenclawBundledPluginPostinstall({ openclawDir: installPaths.openclawDir });
};

main();
