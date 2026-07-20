const fs = require("fs");
const path = require("path");
const { isObject, parseJson } = require("./shared");

const kInstalledPluginIndexKey = "installed-plugin-index";

const resolveLegacyPluginIndexPath = ({ openclawDir }) =>
  path.join(openclawDir, "plugins", "installs.json");

const resolveOpenclawStateDatabasePath = ({ openclawDir }) =>
  path.join(openclawDir, "state", "openclaw.sqlite");

const extractInstallRecords = (index) => {
  if (!isObject(index)) return null;
  if (isObject(index.installRecords)) return index.installRecords;
  if (isObject(index.records)) return index.records;
  if (!Array.isArray(index.plugins)) return null;

  const records = {};
  for (const plugin of index.plugins) {
    if (
      isObject(plugin) &&
      typeof plugin.pluginId === "string" &&
      plugin.pluginId.trim() &&
      isObject(plugin.installRecord)
    ) {
      records[plugin.pluginId] = plugin.installRecord;
    }
  }
  return Object.keys(records).length > 0 ? records : null;
};

const parseExactNpmSpec = (value) => {
  const spec = String(value || "").replace(/^npm:/, "");
  const separator = spec.lastIndexOf("@");
  if (separator <= 0) return null;
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!name || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return null;
  }
  return { name, version };
};

const readStringField = (record, key) =>
  typeof record?.[key] === "string" ? record[key] : undefined;

const legacyRecordCoveredByCurrent = (currentRecord, legacyRecord) => {
  if (!isObject(currentRecord) || !isObject(legacyRecord)) return false;
  if (currentRecord.source !== legacyRecord.source) return false;

  if (currentRecord.source === "npm") {
    const legacyIdentity = parseExactNpmSpec(legacyRecord.spec);
    const currentIdentity =
      readStringField(currentRecord, "resolvedName") &&
      readStringField(currentRecord, "resolvedVersion")
        ? {
            name: currentRecord.resolvedName,
            version: currentRecord.resolvedVersion,
          }
        : parseExactNpmSpec(currentRecord.resolvedSpec);
    if (
      legacyIdentity &&
      currentIdentity &&
      legacyIdentity.name === currentIdentity.name &&
      legacyIdentity.version === currentIdentity.version
    ) {
      return true;
    }
  }

  for (const key of Object.keys(legacyRecord).sort()) {
    if (currentRecord[key] === legacyRecord[key]) continue;
    if (
      key === "spec" &&
      readStringField(currentRecord, "resolvedSpec") ===
        readStringField(legacyRecord, "spec")
    ) {
      continue;
    }
    if (
      (key === "resolvedAt" || key === "installedAt") &&
      typeof currentRecord[key] === "string"
    ) {
      continue;
    }
    return false;
  }
  return true;
};

const openInstalledPluginIndexDatabase = ({ databasePath, readOnly = false }) => {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(databasePath, { readOnly });
};

const readInstalledPluginIndexRow = ({ databasePath }) => {
  if (!fs.existsSync(databasePath)) return null;
  let database;
  try {
    database = openInstalledPluginIndexDatabase({ databasePath, readOnly: true });
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installed_plugin_index'",
      )
      .get();
    if (!table) return null;
    return (
      database
        .prepare("SELECT * FROM installed_plugin_index WHERE index_key = ?")
        .get(kInstalledPluginIndexKey) || null
    );
  } catch {
    return null;
  } finally {
    database?.close();
  }
};

const inspectPluginIndexConflict = ({ fsModule = fs, openclawDir }) => {
  const legacyPath = resolveLegacyPluginIndexPath({ openclawDir });
  const databasePath = resolveOpenclawStateDatabasePath({ openclawDir });
  if (!fsModule.existsSync(legacyPath) || !fsModule.existsSync(databasePath)) {
    return {
      pending: false,
      legacyPath,
      databasePath,
      conflictingPluginIds: [],
    };
  }

  const legacyIndex = parseJson(fsModule.readFileSync(legacyPath, "utf8"));
  const legacyRecords = extractInstallRecords(legacyIndex);
  const sqliteRow = readInstalledPluginIndexRow({ databasePath });
  const currentRecords = parseJson(sqliteRow?.install_records_json, null);
  if (!legacyRecords || !isObject(currentRecords)) {
    return {
      pending: false,
      legacyPath,
      databasePath,
      conflictingPluginIds: [],
    };
  }

  const conflictingPluginIds = Object.entries(legacyRecords)
    .filter(([pluginId, legacyRecord]) => {
      const currentRecord = currentRecords[pluginId];
      return (
        currentRecord &&
        !legacyRecordCoveredByCurrent(currentRecord, legacyRecord)
      );
    })
    .map(([pluginId]) => pluginId)
    .sort();

  return {
    pending: conflictingPluginIds.length > 0,
    legacyPath,
    databasePath,
    legacyIndex,
    legacyRecords,
    sqliteRow,
    currentRecords,
    conflictingPluginIds,
  };
};

const toJsonSafe = (value) => {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)]),
  );
};

const writePrivateJson = ({ fsModule = fs, filePath, value }) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fsModule.writeFileSync(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fsModule.renameSync(temporaryPath, filePath);
  fsModule.chmodSync(filePath, 0o600);
};

const formatTimestamp = (now) => now.toISOString().replace(/[^0-9TZ]/g, "");

const resolveAvailableBackupPath = ({ fsModule = fs, basePath }) => {
  if (!fsModule.existsSync(basePath)) return basePath;
  const extension = path.extname(basePath);
  const stem = basePath.slice(0, -extension.length);
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}.${index}${extension}`;
    if (!fsModule.existsSync(candidate)) return candidate;
  }
};

const repairPluginIndexConflict = ({
  fsModule = fs,
  rootDir,
  openclawDir,
  now = new Date(),
}) => {
  const inspection = inspectPluginIndexConflict({ fsModule, openclawDir });
  if (!inspection.pending) {
    return {
      changed: false,
      changes: ["OpenClaw plugin install metadata did not conflict."],
    };
  }

  const backupDir = path.join(rootDir, "migrations");
  const timestamp = formatTimestamp(now);
  const backupPath = resolveAvailableBackupPath({
    fsModule,
    basePath: path.join(
      backupDir,
      `openclaw-plugin-index-conflict-${timestamp}.json`,
    ),
  });
  writePrivateJson({
    fsModule,
    filePath: backupPath,
    value: {
      schemaVersion: 1,
      createdAt: now.toISOString(),
      legacyPath: inspection.legacyPath,
      databasePath: inspection.databasePath,
      conflictingPluginIds: inspection.conflictingPluginIds,
      legacyIndex: inspection.legacyIndex,
      sqliteRow: toJsonSafe(inspection.sqliteRow),
    },
  });

  const mergedRecords = { ...inspection.currentRecords, ...inspection.legacyRecords };
  const nextLegacyIndex = {
    ...inspection.legacyIndex,
    installRecords: mergedRecords,
  };
  delete nextLegacyIndex.records;
  writePrivateJson({
    fsModule,
    filePath: inspection.legacyPath,
    value: nextLegacyIndex,
  });

  const database = openInstalledPluginIndexDatabase({
    databasePath: inspection.databasePath,
  });
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("DELETE FROM installed_plugin_index WHERE index_key = ?")
      .run(kInstalledPluginIndexKey);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }

  return {
    changed: true,
    changes: [
      `Backed up conflicting OpenClaw plugin metadata to ${backupPath}.`,
      `Reset the shared SQLite plugin install index so OpenClaw doctor can migrate ${inspection.legacyPath}.`,
      `Preserved current-only plugin records and preferred legacy metadata for conflicts: ${inspection.conflictingPluginIds.join(", ")}.`,
    ],
  };
};

module.exports = {
  extractInstallRecords,
  inspectPluginIndexConflict,
  repairPluginIndexConflict,
  resolveLegacyPluginIndexPath,
  resolveOpenclawStateDatabasePath,
};
