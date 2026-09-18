const fs = require("fs");
const {
  extractInstallRecords,
  inspectPluginIndexConflict,
  repairPluginIndexConflict,
  resolveLegacyPluginIndexPath,
  resolveOpenclawStateDatabasePath,
} = require("./plugin-index");

const inspectOpenclawStartupState = ({ fsModule = fs, openclawDir }) => {
  const blockers = [];
  const legacyPluginIndexPath = resolveLegacyPluginIndexPath({ openclawDir });
  if (fsModule.existsSync(legacyPluginIndexPath)) {
    blockers.push({
      type: "legacy-plugin-index",
      path: legacyPluginIndexPath,
      message: "OpenClaw legacy plugin install index is still present after doctor.",
    });
  }
  return { ok: blockers.length === 0, blockers };
};

module.exports = {
  extractInstallRecords,
  inspectOpenclawStartupState,
  inspectPluginIndexConflict,
  repairPluginIndexConflict,
  resolveLegacyPluginIndexPath,
  resolveOpenclawStateDatabasePath,
};
