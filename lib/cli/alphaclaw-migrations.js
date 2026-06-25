const fs = require("fs");
const path = require("path");

const kMigrationLedgerDir = "migrations";
const kMigrationLedgerFileName = "alphaclaw-migrations.jsonl";
const kMigrationFailureBlockThreshold = 3;

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const resolveMigrationLedgerPath = ({ rootDir }) =>
  path.join(rootDir, kMigrationLedgerDir, kMigrationLedgerFileName);

const writeJsonFile = ({ fsModule = fs, filePath, value }) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

const readMigrationLedger = ({ fsModule = fs, rootDir }) => {
  const ledgerPath = resolveMigrationLedgerPath({ rootDir });
  try {
    const raw = fsModule.readFileSync(ledgerPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const appendMigrationLedgerEntry = ({
  fsModule = fs,
  rootDir,
  entry,
  now = new Date(),
}) => {
  const ledgerPath = resolveMigrationLedgerPath({ rootDir });
  fsModule.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const payload = {
    timestamp: now.toISOString(),
    ...entry,
  };
  fsModule.appendFileSync(ledgerPath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
};

const getRecentFailureCount = ({ ledger = [], migrationId }) => {
  let count = 0;
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index];
    if (entry?.id !== migrationId) continue;
    if (entry.status === "completed") return count;
    if (entry.status === "failed") count += 1;
  }
  return count;
};

const removeActiveMemoryModelFallbackPolicy = {
  id: "2026-06-remove-active-memory-model-fallback-policy",
  title: "Remove deprecated Active Memory modelFallbackPolicy",
  scope: "config",
  target: "openclaw.json",
  description:
    "AlphaClaw used to write plugins.entries.active-memory.config.modelFallbackPolicy. " +
    "OpenClaw now ignores it and logs a warning when it is present.",
  check({ fsModule = fs, openclawDir }) {
    const configPath = path.join(openclawDir, "openclaw.json");
    if (!fsModule.existsSync(configPath)) {
      return {
        status: "ok",
        message: "openclaw.json is missing; nothing to migrate",
      };
    }
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    const activeMemoryConfig = config.plugins?.entries?.["active-memory"]?.config;
    if (
      !isObject(activeMemoryConfig) ||
      !Object.prototype.hasOwnProperty.call(activeMemoryConfig, "modelFallbackPolicy")
    ) {
      return {
        status: "ok",
        message: "Deprecated Active Memory modelFallbackPolicy is absent",
      };
    }
    return {
      status: "pending",
      message:
        "Remove plugins.entries.active-memory.config.modelFallbackPolicy from openclaw.json",
      details: {
        path: "plugins.entries.active-memory.config.modelFallbackPolicy",
      },
    };
  },
  apply({ fsModule = fs, openclawDir }) {
    const configPath = path.join(openclawDir, "openclaw.json");
    if (!fsModule.existsSync(configPath)) {
      return {
        changed: false,
        changes: ["Skipped openclaw.json because it is missing."],
      };
    }
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    const activeMemoryConfig = config.plugins?.entries?.["active-memory"]?.config;
    if (
      !isObject(activeMemoryConfig) ||
      !Object.prototype.hasOwnProperty.call(activeMemoryConfig, "modelFallbackPolicy")
    ) {
      return {
        changed: false,
        changes: ["Deprecated Active Memory modelFallbackPolicy was already absent."],
      };
    }
    delete activeMemoryConfig.modelFallbackPolicy;
    writeJsonFile({ fsModule, filePath: configPath, value: config });
    return {
      changed: true,
      changes: [
        "Removed plugins.entries.active-memory.config.modelFallbackPolicy from openclaw.json.",
      ],
    };
  },
};

const kAlphaClawMigrations = [removeActiveMemoryModelFallbackPolicy];

const runAlphaClawMigrations = ({
  fsModule = fs,
  rootDir,
  openclawDir = path.join(rootDir, ".openclaw"),
  fix = false,
  forceRetry = "",
  migrations = kAlphaClawMigrations,
  now = new Date(),
} = {}) => {
  if (!rootDir) throw new Error("rootDir is required");
  const ledger = readMigrationLedger({ fsModule, rootDir });
  const forceRetryId = String(forceRetry || "").trim();
  const results = [];

  for (const migration of migrations) {
    const base = {
      id: migration.id,
      title: migration.title,
      scope: migration.scope,
      target: migration.target,
      description: migration.description,
    };
    let checkResult;
    try {
      checkResult = migration.check({ fsModule, rootDir, openclawDir });
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        error: error.message || String(error),
      });
      continue;
    }

    if (checkResult.status !== "pending") {
      results.push({
        ...base,
        status: "ok",
        message: checkResult.message || "No migration needed",
      });
      continue;
    }

    const recentFailureCount = getRecentFailureCount({
      ledger,
      migrationId: migration.id,
    });
    const forceThisMigration =
      forceRetryId === migration.id ||
      forceRetryId === "all" ||
      forceRetryId === "*";
    if (
      recentFailureCount >= kMigrationFailureBlockThreshold &&
      !forceThisMigration
    ) {
      results.push({
        ...base,
        status: "blocked",
        message:
          `Migration has failed ${recentFailureCount} consecutive times; rerun with ` +
          `--force-retry ${migration.id} after inspecting the failure.`,
        details: checkResult.details || null,
      });
      continue;
    }

    if (!fix) {
      results.push({
        ...base,
        status: "pending",
        message: checkResult.message || "Migration is pending",
        details: checkResult.details || null,
      });
      continue;
    }

    try {
      const applyResult = migration.apply({ fsModule, rootDir, openclawDir });
      const entry = appendMigrationLedgerEntry({
        fsModule,
        rootDir,
        now,
        entry: {
          id: migration.id,
          status: "completed",
          scope: migration.scope,
          target: migration.target,
          changed: applyResult.changed === true,
          changes: applyResult.changes || [],
        },
      });
      ledger.push(entry);
      results.push({
        ...base,
        status: applyResult.changed ? "fixed" : "ok",
        message: applyResult.changed ? "Migration applied" : "Migration already satisfied",
        changes: applyResult.changes || [],
      });
    } catch (error) {
      const entry = appendMigrationLedgerEntry({
        fsModule,
        rootDir,
        now,
        entry: {
          id: migration.id,
          status: "failed",
          scope: migration.scope,
          target: migration.target,
          error: error.message || String(error),
        },
      });
      ledger.push(entry);
      results.push({
        ...base,
        status: "failed",
        error: error.message || String(error),
      });
    }
  }

  const summary = results.reduce(
    (acc, result) => {
      acc.total += 1;
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );
  return {
    ok: !results.some(
      (result) => result.status === "failed" || result.status === "blocked",
    ),
    fix: fix === true,
    rootDir,
    openclawDir,
    ledgerPath: resolveMigrationLedgerPath({ rootDir }),
    summary,
    results,
  };
};

module.exports = {
  kAlphaClawMigrations,
  kMigrationFailureBlockThreshold,
  appendMigrationLedgerEntry,
  readMigrationLedger,
  resolveMigrationLedgerPath,
  runAlphaClawMigrations,
};
