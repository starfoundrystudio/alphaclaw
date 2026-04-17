const path = require("path");

const hasOpenclawConfig = ({ fs, openclawDir, pathModule = path }) =>
  fs.existsSync(pathModule.join(openclawDir, "openclaw.json"));

const shouldInitializeManagedOpenclawRuntime = ({
  fs,
  onboardingMarkerPath,
  openclawDir,
  pathModule = path,
}) =>
  fs.existsSync(onboardingMarkerPath) ||
  hasOpenclawConfig({
    fs,
    openclawDir,
    pathModule,
  });

module.exports = {
  hasOpenclawConfig,
  shouldInitializeManagedOpenclawRuntime,
};
