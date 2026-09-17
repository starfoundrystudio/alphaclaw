"use strict";

const kMinimumManagedSqliteVersion = [3, 51, 3];
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
  if (major === 24) return minor > 16 || (minor === 16 && patch >= 0);
  if (major === 26) return minor > 1 || (minor === 1 && patch >= 0);
  return major > 26;
};

const isSupportedManagedSqliteVersion = (value) => {
  const version = parseVersion(value);
  if (!version) return false;
  return compareVersions(version, kMinimumManagedSqliteVersion) >= 0;
};

const assertSafeNodeSqliteRuntime = ({
  nodeVersion = process.versions.node,
  sqliteModule,
} = {}) => {
  if (!isSupportedOpenclawNodeVersion(nodeVersion)) {
    throw new Error(
      `Clawbridge requires an OpenClaw-supported Node runtime; found Node ${nodeVersion}. ` +
        "Upgrade to Node 24.16.0+ on 24.x or Node 26.1.0+ before retrying.",
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
  if (!isSupportedManagedSqliteVersion(sqliteVersion)) {
    throw new Error(
      "Clawbridge managed hosts require SQLite 3.51.3+ for WAL safety; " +
        `Node ${nodeVersion} loaded SQLite ${sqliteVersion}. Upgrade to Node 24.16.0+ ` +
        "on 24.x or Node 26.1.0+ before retrying.",
    );
  }
  kValidatedSqliteModule = sqlite;
  return sqlite;
};

module.exports = {
  assertSafeNodeSqliteRuntime,
  isSupportedManagedSqliteVersion,
  isSupportedOpenclawNodeVersion,
};
