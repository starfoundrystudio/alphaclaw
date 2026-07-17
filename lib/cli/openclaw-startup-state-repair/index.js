const fs = require("fs");
const {
  extractInstallRecords,
  inspectPluginIndexConflict,
  repairPluginIndexConflict,
  resolveLegacyPluginIndexPath,
  resolveOpenclawStateDatabasePath,
} = require("./plugin-index");
const {
  inspectForeignHarnessCodexSidecars,
  repairForeignHarnessCodexSidecars,
  walkCodexBindingSidecars,
} = require("./codex-sidecars");

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
  for (const sidecarPath of walkCodexBindingSidecars({ fsModule, openclawDir })) {
    blockers.push({
      type: "codex-binding-sidecar",
      path: sidecarPath,
      message: "Legacy Codex binding sidecar is still present after doctor.",
    });
  }
  return { ok: blockers.length === 0, blockers };
};

module.exports = {
  extractInstallRecords,
  inspectForeignHarnessCodexSidecars,
  inspectOpenclawStartupState,
  inspectPluginIndexConflict,
  repairForeignHarnessCodexSidecars,
  repairPluginIndexConflict,
  resolveLegacyPluginIndexPath,
  resolveOpenclawStateDatabasePath,
  walkCodexBindingSidecars,
};
