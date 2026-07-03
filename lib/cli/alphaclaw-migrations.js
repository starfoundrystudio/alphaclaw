const fs = require("fs");
const path = require("path");
const {
  ensureManagedPluginApprovalDefaults,
} = require("../server/exec-defaults-config");

const kMigrationLedgerDir = "migrations";
const kMigrationLedgerFileName = "alphaclaw-migrations.jsonl";
const kMigrationFailureBlockThreshold = 3;

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value) => String(value || "").trim();

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

const hasCodexRuntime = (value) =>
  normalizeString(value?.agentRuntime?.id) === "codex";

const modelKeyUsesOpenAiProvider = (modelKey) => {
  const provider = normalizeString(modelKey).split("/")[0];
  return provider === "openai" || provider === "openai-codex";
};

const configUsesOpenAiCodexRuntime = (config) => {
  if (hasCodexRuntime(config.models?.providers?.openai)) return true;
  if (hasCodexRuntime(config.agents?.defaults)) return true;

  const defaultModels = config.agents?.defaults?.models;
  if (!isObject(defaultModels)) return false;
  return Object.entries(defaultModels).some(
    ([modelKey, modelConfig]) =>
      modelKeyUsesOpenAiProvider(modelKey) && hasCodexRuntime(modelConfig),
  );
};

const getConfiguredOpenAiProfileIds = (config) =>
  Object.entries(config.auth?.profiles || {})
    .filter(([, profile]) => normalizeString(profile?.provider) === "openai")
    .map(([profileId]) => profileId);

const buildCodexPreferredOpenAiAuthOrder = (config) => {
  const existingOrder = Array.isArray(config.auth?.order?.openai)
    ? config.auth.order.openai
    : [];
  const configuredProfiles = getConfiguredOpenAiProfileIds(config);
  const seen = new Set(["openai:codex-cli"]);
  const ordered = ["openai:codex-cli"];

  for (const profileId of [...existingOrder, ...configuredProfiles]) {
    const normalized = normalizeString(profileId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
};

const preferCodexCliOpenAiAuthProfile = {
  id: "2026-06-prefer-codex-cli-openai-auth-profile",
  title: "Prefer Codex CLI OAuth for OpenAI Codex runtime",
  scope: "config",
  target: "openclaw.json",
  description:
    "When OpenAI models run through the Codex runtime, OpenClaw resolves a single " +
    "OpenAI auth profile for the Codex bridge. AlphaClaw should prefer the " +
    "Codex CLI OAuth profile when it exists, while preserving other OpenAI profiles.",
  check({ fsModule = fs, openclawDir }) {
    const configPath = path.join(openclawDir, "openclaw.json");
    if (!fsModule.existsSync(configPath)) {
      return {
        status: "ok",
        message: "openclaw.json is missing; nothing to migrate",
      };
    }
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    if (!configUsesOpenAiCodexRuntime(config)) {
      return {
        status: "ok",
        message: "OpenAI Codex runtime is not configured",
      };
    }
    const codexProfile = config.auth?.profiles?.["openai:codex-cli"];
    if (
      !isObject(codexProfile) ||
      normalizeString(codexProfile.provider) !== "openai" ||
      normalizeString(codexProfile.mode) !== "oauth"
    ) {
      return {
        status: "ok",
        message: "openai:codex-cli OAuth profile is not configured",
      };
    }
    if (config.auth?.order?.openai?.[0] === "openai:codex-cli") {
      return {
        status: "ok",
        message: "openai:codex-cli is already the preferred OpenAI auth profile",
      };
    }
    return {
      status: "pending",
      message:
        "Prefer openai:codex-cli first in auth.order.openai for Codex runtime models",
      details: {
        path: "auth.order.openai",
        preferredProfileId: "openai:codex-cli",
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
    if (!configUsesOpenAiCodexRuntime(config)) {
      return {
        changed: false,
        changes: ["OpenAI Codex runtime was not configured."],
      };
    }
    const codexProfile = config.auth?.profiles?.["openai:codex-cli"];
    if (
      !isObject(codexProfile) ||
      normalizeString(codexProfile.provider) !== "openai" ||
      normalizeString(codexProfile.mode) !== "oauth"
    ) {
      return {
        changed: false,
        changes: ["openai:codex-cli OAuth profile was not configured."],
      };
    }

    const nextOrder = buildCodexPreferredOpenAiAuthOrder(config);
    const previousOrder = Array.isArray(config.auth?.order?.openai)
      ? config.auth.order.openai
      : [];
    const alreadySatisfied =
      previousOrder.length === nextOrder.length &&
      previousOrder.every((profileId, index) => profileId === nextOrder[index]);
    if (alreadySatisfied) {
      return {
        changed: false,
        changes: ["openai:codex-cli was already first in auth.order.openai."],
      };
    }

    if (!isObject(config.auth)) config.auth = {};
    if (!isObject(config.auth.order)) config.auth.order = {};
    config.auth.order.openai = nextOrder;
    writeJsonFile({ fsModule, filePath: configPath, value: config });
    return {
      changed: true,
      changes: [
        "Updated auth.order.openai to prefer openai:codex-cli for Codex runtime models.",
      ],
    };
  },
};

const ensurePluginApprovalForwarding = {
  id: "2026-07-enable-plugin-approval-forwarding",
  title: "Enable plugin approval forwarding defaults",
  scope: "config",
  target: "openclaw.json",
  description:
    "Skill Workshop apply/reject/quarantine actions use OpenClaw's plugin " +
    "approval channel. Existing AlphaClaw installs need approvals.plugin " +
    "defaults so those approval prompts can be routed without switching Skill " +
    "Workshop to auto-approval.",
  check({ fsModule = fs, openclawDir }) {
    const configPath = path.join(openclawDir, "openclaw.json");
    if (!fsModule.existsSync(configPath)) {
      return {
        status: "ok",
        message: "openclaw.json is missing; nothing to migrate",
      };
    }
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    const ensured = ensureManagedPluginApprovalDefaults(
      JSON.parse(JSON.stringify(config)),
    );
    if (!ensured.changed) {
      return {
        status: "ok",
        message: "Plugin approval forwarding defaults are already configured",
      };
    }
    return {
      status: "pending",
      message:
        "Add approvals.plugin defaults to openclaw.json for Skill Workshop approval routing",
      details: {
        path: "approvals.plugin",
        defaults: {
          enabled: true,
          mode: "session",
        },
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
    const ensured = ensureManagedPluginApprovalDefaults(config);
    if (!ensured.changed) {
      return {
        changed: false,
        changes: ["approvals.plugin defaults were already configured."],
      };
    }
    writeJsonFile({ fsModule, filePath: configPath, value: ensured.config });
    return {
      changed: true,
      changes: [
        "Added approvals.plugin.enabled=true and approvals.plugin.mode=\"session\" defaults to openclaw.json.",
      ],
    };
  },
};

const kAlphaClawMigrations = [
  removeActiveMemoryModelFallbackPolicy,
  preferCodexCliOpenAiAuthProfile,
  ensurePluginApprovalForwarding,
];

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
