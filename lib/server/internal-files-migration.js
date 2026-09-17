const path = require("path");

const kInternalDirName = ".alphaclaw";
const kHourlyGitSyncFileName = "hourly-git-sync.sh";
const kHourlyGitSyncCronPath = "/etc/cron.d/openclaw-hourly-sync";
const kCliDeviceAutoApprovedFileName = ".cli-device-auto-approved";

const buildManagedPaths = ({ openclawDir, pathModule = path }) => {
  const internalDir = pathModule.join(openclawDir, kInternalDirName);
  return {
    internalDir,
    cliDeviceAutoApprovedPath: pathModule.join(
      internalDir,
      kCliDeviceAutoApprovedFileName,
    ),
    retiredHourlyGitSyncPath: pathModule.join(
      internalDir,
      kHourlyGitSyncFileName,
    ),
    legacyHourlyGitSyncPath: pathModule.join(
      openclawDir,
      kHourlyGitSyncFileName,
    ),
    retiredHourlyGitSyncConfigPath: pathModule.join(
      openclawDir,
      "cron",
      "system-sync.json",
    ),
    legacyCliDeviceAutoApprovedPath: pathModule.join(
      openclawDir,
      kCliDeviceAutoApprovedFileName,
    ),
  };
};

const removeRetiredGitSyncArtifacts = ({
  fs,
  managedPaths,
  systemCronPath = kHourlyGitSyncCronPath,
}) => {
  for (const retiredPath of [
    managedPaths.retiredHourlyGitSyncPath,
    managedPaths.legacyHourlyGitSyncPath,
    managedPaths.retiredHourlyGitSyncConfigPath,
    systemCronPath,
  ]) {
    try {
      fs.rmSync(retiredPath, { force: true });
    } catch {}
  }
};

const moveFile = ({ fs, sourcePath, targetPath, mode }) => {
  try {
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch {
    fs.copyFileSync(sourcePath, targetPath);
    if (Number.isFinite(mode)) {
      fs.chmodSync(targetPath, mode);
    }
    fs.rmSync(sourcePath, { force: true });
    return true;
  }
};

const migrateManagedInternalFiles = ({
  fs,
  openclawDir,
  pathModule = path,
  logger = console,
  systemCronPath = kHourlyGitSyncCronPath,
}) => {
  const managedPaths = buildManagedPaths({ openclawDir, pathModule });
  fs.mkdirSync(managedPaths.internalDir, { recursive: true });

  const migrateOne = ({ sourcePaths, targetPath }) => {
    const existingSourcePath = sourcePaths.find((sourcePath) =>
      fs.existsSync(sourcePath),
    );
    if (fs.existsSync(targetPath)) {
      sourcePaths.forEach((sourcePath) => {
        if (sourcePath !== targetPath && fs.existsSync(sourcePath)) {
          fs.rmSync(sourcePath, { force: true });
        }
      });
      return;
    }
    if (!existingSourcePath) return;
    const sourceStats = fs.statSync(existingSourcePath);
    moveFile({
      fs,
      sourcePath: existingSourcePath,
      targetPath,
      mode: sourceStats.mode,
    });
    sourcePaths.forEach((sourcePath) => {
      if (
        sourcePath !== existingSourcePath &&
        sourcePath !== targetPath &&
        fs.existsSync(sourcePath)
      ) {
        fs.rmSync(sourcePath, { force: true });
      }
    });
  };

  try {
    removeRetiredGitSyncArtifacts({ fs, managedPaths, systemCronPath });
    migrateOne({
      sourcePaths: [managedPaths.legacyCliDeviceAutoApprovedPath],
      targetPath: managedPaths.cliDeviceAutoApprovedPath,
    });
  } catch (error) {
    logger.error?.(
      `[alphaclaw] Failed to migrate internal managed files: ${error.message || String(error)}`,
    );
  }

  return managedPaths;
};

module.exports = {
  buildManagedPaths,
  migrateManagedInternalFiles,
};
