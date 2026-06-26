const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readMigrationLedger,
  resolveMigrationLedgerPath,
  runAlphaClawMigrations,
} = require("../../lib/cli/alphaclaw-migrations");

const makeRoot = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-migrate-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  return { rootDir, openclawDir };
};

const writeOpenclawConfig = (openclawDir, config) => {
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
};

const readOpenclawConfig = (openclawDir) =>
  JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

describe("AlphaClaw migrations", () => {
  let tempRoots = [];

  afterEach(() => {
    for (const rootDir of tempRoots) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  const createRoot = () => {
    const root = makeRoot();
    tempRoots.push(root.rootDir);
    return root;
  };

  it("reports deprecated Active Memory modelFallbackPolicy without mutating in dry-run mode", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      gateway: { mode: "local" },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: {
              modelFallbackPolicy: "default-remote",
              queryMode: "recent",
            },
          },
        },
      },
    });

    const result = runAlphaClawMigrations({ rootDir, openclawDir });

    expect(result.ok).toBe(true);
    expect(result.summary.pending).toBe(1);
    expect(result.results[0]).toMatchObject({
      id: "2026-06-remove-active-memory-model-fallback-policy",
      status: "pending",
      scope: "config",
      target: "openclaw.json",
    });
    expect(
      readOpenclawConfig(openclawDir).plugins.entries["active-memory"].config
        .modelFallbackPolicy,
    ).toBe("default-remote");
    expect(fs.existsSync(resolveMigrationLedgerPath({ rootDir }))).toBe(false);
  });

  it("removes deprecated Active Memory modelFallbackPolicy and writes a ledger entry", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      gateway: { mode: "local" },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: {
              modelFallbackPolicy: "default-remote",
              queryMode: "full",
              model: "anthropic/claude-sonnet-4.6",
            },
          },
        },
      },
    });

    const result = runAlphaClawMigrations({
      rootDir,
      openclawDir,
      fix: true,
      now: new Date("2026-06-25T20:00:00.000Z"),
    });
    const nextConfig = readOpenclawConfig(openclawDir);
    const ledger = readMigrationLedger({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.summary.fixed).toBe(1);
    expect(
      nextConfig.plugins.entries["active-memory"].config.modelFallbackPolicy,
    ).toBeUndefined();
    expect(nextConfig.plugins.entries["active-memory"].config.queryMode).toBe("full");
    expect(nextConfig.plugins.entries["active-memory"].config.model).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(ledger).toEqual([
      expect.objectContaining({
        timestamp: "2026-06-25T20:00:00.000Z",
        id: "2026-06-remove-active-memory-model-fallback-policy",
        status: "completed",
        scope: "config",
        target: "openclaw.json",
        changed: true,
      }),
    ]);
  });

  it("is idempotent after the deprecated key has already been removed", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      gateway: { mode: "local" },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: { queryMode: "recent" },
          },
        },
      },
    });

    const result = runAlphaClawMigrations({ rootDir, openclawDir, fix: true });

    expect(result.ok).toBe(true);
    expect(result.summary.ok).toBe(2);
    expect(fs.existsSync(resolveMigrationLedgerPath({ rootDir }))).toBe(false);
  });

  it("fails clearly when openclaw.json exists but is not valid JSON", () => {
    const { rootDir, openclawDir } = createRoot();
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{not-json", "utf8");

    const result = runAlphaClawMigrations({ rootDir, openclawDir, fix: true });

    expect(result.ok).toBe(false);
    expect(result.summary.failed).toBe(2);
    expect(result.results[0]).toMatchObject({
      id: "2026-06-remove-active-memory-model-fallback-policy",
      status: "failed",
    });
    expect(result.results[0].error).toMatch(/JSON/);
  });

  it("reports OpenAI Codex runtime auth order migration without mutating in dry-run mode", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
      auth: {
        profiles: {
          "openai:bill@example.com": {
            provider: "openai",
            mode: "oauth",
            email: "bill@example.com",
          },
          "openai:codex-cli": {
            provider: "openai",
            mode: "oauth",
          },
        },
      },
    });

    const result = runAlphaClawMigrations({ rootDir, openclawDir });

    expect(result.ok).toBe(true);
    expect(result.summary.pending).toBe(1);
    expect(result.results[1]).toMatchObject({
      id: "2026-06-prefer-codex-cli-openai-auth-profile",
      status: "pending",
      scope: "config",
      target: "openclaw.json",
    });
    expect(readOpenclawConfig(openclawDir).auth.order).toBeUndefined();
  });

  it("prefers openai:codex-cli for OpenAI Codex runtime models while preserving other profiles", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      models: {
        providers: {
          openai: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      auth: {
        profiles: {
          "openai:bill@example.com": {
            provider: "openai",
            mode: "oauth",
            email: "bill@example.com",
          },
          "openai:codex-cli": {
            provider: "openai",
            mode: "oauth",
          },
          "anthropic:default": {
            provider: "anthropic",
            mode: "token",
          },
        },
        order: {
          openai: ["openai:bill@example.com"],
          anthropic: ["anthropic:default"],
        },
      },
    });

    const result = runAlphaClawMigrations({
      rootDir,
      openclawDir,
      fix: true,
      now: new Date("2026-06-26T15:00:00.000Z"),
    });
    const nextConfig = readOpenclawConfig(openclawDir);
    const ledger = readMigrationLedger({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.summary.fixed).toBe(1);
    expect(nextConfig.auth.order.openai).toEqual([
      "openai:codex-cli",
      "openai:bill@example.com",
    ]);
    expect(nextConfig.auth.order.anthropic).toEqual(["anthropic:default"]);
    expect(nextConfig.auth.profiles["openai:bill@example.com"]).toBeDefined();
    expect(ledger).toContainEqual(
      expect.objectContaining({
        timestamp: "2026-06-26T15:00:00.000Z",
        id: "2026-06-prefer-codex-cli-openai-auth-profile",
        status: "completed",
        scope: "config",
        target: "openclaw.json",
        changed: true,
      }),
    );
  });

  it("does not change OpenAI API-key or non-Codex-runtime setups", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "token",
          },
          "openai:codex-cli": {
            provider: "openai",
            mode: "oauth",
          },
        },
      },
    });

    const result = runAlphaClawMigrations({ rootDir, openclawDir, fix: true });

    expect(result.ok).toBe(true);
    expect(result.summary.fixed || 0).toBe(0);
    expect(readOpenclawConfig(openclawDir).auth.order).toBeUndefined();
  });

  it("is idempotent when openai:codex-cli is already first", () => {
    const { rootDir, openclawDir } = createRoot();
    writeOpenclawConfig(openclawDir, {
      models: {
        providers: {
          openai: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      auth: {
        profiles: {
          "openai:codex-cli": {
            provider: "openai",
            mode: "oauth",
          },
          "openai:bill@example.com": {
            provider: "openai",
            mode: "oauth",
            email: "bill@example.com",
          },
        },
        order: {
          openai: ["openai:codex-cli", "openai:bill@example.com"],
        },
      },
    });

    const result = runAlphaClawMigrations({ rootDir, openclawDir, fix: true });

    expect(result.ok).toBe(true);
    expect(result.summary.fixed || 0).toBe(0);
    expect(readOpenclawConfig(openclawDir).auth.order.openai).toEqual([
      "openai:codex-cli",
      "openai:bill@example.com",
    ]);
    expect(fs.existsSync(resolveMigrationLedgerPath({ rootDir }))).toBe(false);
  });

  it("blocks a migration after repeated failures until force retry is requested", () => {
    const { rootDir, openclawDir } = createRoot();
    const failingMigration = {
      id: "test-failing-migration",
      title: "Failing migration",
      scope: "state",
      target: "state",
      description: "A test migration that always fails",
      check: () => ({ status: "pending", message: "Needs work" }),
      apply: () => {
        throw new Error("boom");
      },
    };

    for (let index = 0; index < 3; index += 1) {
      const result = runAlphaClawMigrations({
        rootDir,
        openclawDir,
        fix: true,
        migrations: [failingMigration],
      });
      expect(result.summary.failed).toBe(1);
    }

    const blocked = runAlphaClawMigrations({
      rootDir,
      openclawDir,
      fix: true,
      migrations: [failingMigration],
    });
    const forced = runAlphaClawMigrations({
      rootDir,
      openclawDir,
      fix: true,
      forceRetry: "test-failing-migration",
      migrations: [failingMigration],
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.results[0]).toMatchObject({ status: "blocked" });
    expect(forced.results[0]).toMatchObject({ status: "failed" });
  });
});
