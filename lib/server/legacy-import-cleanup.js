const fs = require("fs");
const os = require("os");
const path = require("path");

const kLegacyImportTempPrefix = "alphaclaw-import-";
const kLegacyImportTempTtlMs = 24 * 60 * 60 * 1000;

const cleanupLegacyImportTempDirs = ({
  fsModule = fs,
  maxAgeMs = kLegacyImportTempTtlMs,
  nowMs = Date.now(),
} = {}) => {
  const tempRoot = path.resolve(os.tmpdir());
  let removedCount = 0;
  let entries = [];

  try {
    entries = fsModule.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return { removedCount };
  }

  for (const entry of entries) {
    if (!entry?.isDirectory?.()) continue;
    if (!String(entry.name || "").startsWith(kLegacyImportTempPrefix)) continue;

    const candidate = path.join(tempRoot, entry.name);
    try {
      const stats = fsModule.statSync(candidate);
      const ageMs = nowMs - Number(stats?.mtimeMs || 0);
      if (ageMs < maxAgeMs) continue;
      fsModule.rmSync(candidate, { recursive: true, force: true });
      removedCount += 1;
    } catch {}
  }

  return { removedCount };
};

module.exports = {
  kLegacyImportTempPrefix,
  kLegacyImportTempTtlMs,
  cleanupLegacyImportTempDirs,
};
