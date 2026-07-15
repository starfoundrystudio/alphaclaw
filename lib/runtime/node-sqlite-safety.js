"use strict";

const kSqliteWalResetFixedVersion = [3, 51, 3];
const kSqliteWalResetBackports = [
  [3, 44, 6],
  [3, 50, 7],
];
const kVersionPattern = /^(\d+)\.(\d+)\.(\d+)/;

let kValidatedSqliteModule;

const parseVersion = (value) => {
  const match = kVersionPattern.exec(String(value || "").trim().replace(/^v/, ""));
  if (!match) return null;
  const version = match.slice(1, 4).map(Number);
  return version.every(Number.isSafeInteger) ? version : null;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const isSupportedOpenclawNodeVersion = (value) => {
  const version = parseVersion(value);
  if (!version) return false;
  const [major, minor, patch] = version;
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 25) return minor > 9 || (minor === 9 && patch >= 0);
  return major > 25;
};

const isSqliteWalResetSafeVersion = (value) => {
  const version = parseVersion(value);
  if (!version) return false;
  if (compareVersions(version, kSqliteWalResetFixedVersion) >= 0) return true;
  return kSqliteWalResetBackports.some(
    (backport) =>
      version[0] === backport[0] &&
      version[1] === backport[1] &&
      version[2] >= backport[2],
  );
};

const assertSafeNodeSqliteRuntime = ({
  nodeVersion = process.versions.node,
  sqliteModule,
} = {}) => {
  if (!isSupportedOpenclawNodeVersion(nodeVersion)) {
    throw new Error(
      `AlphaClaw requires an OpenClaw-supported Node runtime; found Node ${nodeVersion}. ` +
        "Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.",
    );
  }
  const sqlite = sqliteModule || require("node:sqlite");
  if (kValidatedSqliteModule === sqlite) return sqlite;
  const database = new sqlite.DatabaseSync(":memory:");
  let sqliteVersion = "unknown";
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get();
    if (typeof row?.version === "string") sqliteVersion = row.version;
  } finally {
    database.close();
  }
  if (!isSqliteWalResetSafeVersion(sqliteVersion)) {
    throw new Error(
      "AlphaClaw requires SQLite 3.51.3+ (or patched 3.50.7+/3.44.6+) for WAL safety; " +
        `Node ${nodeVersion} loaded SQLite ${sqliteVersion}. Upgrade to Node 22.22.3+, ` +
        "24.15.0+, or 25.9.0+ before retrying.",
    );
  }
  kValidatedSqliteModule = sqlite;
  return sqlite;
};

module.exports = {
  assertSafeNodeSqliteRuntime,
  isSqliteWalResetSafeVersion,
  isSupportedOpenclawNodeVersion,
};
