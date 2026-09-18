const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  inspectOpenclawStartupState,
  inspectPluginIndexConflict,
} = require("../../lib/cli/openclaw-startup-state-repair");
const {
  runAlphaclawMigrations,
} = require("../../lib/cli/alphaclaw-migrations");

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createPluginIndexDatabase = ({ databasePath, installRecords }) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE installed_plugin_index (
      index_key TEXT PRIMARY KEY,
      install_records_json TEXT NOT NULL
    )
  `);
  database
    .prepare(
      "INSERT INTO installed_plugin_index (index_key, install_records_json) VALUES (?, ?)",
    )
    .run("installed-plugin-index", JSON.stringify(installRecords));
  database.close();
};

describe("OpenClaw startup state repair", () => {
  let rootDir;
  let openclawDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-startup-state-"));
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("backs up and resets only a conflicting SQLite plugin index row", () => {
    const legacyPath = path.join(openclawDir, "plugins", "installs.json");
    const databasePath = path.join(openclawDir, "state", "openclaw.sqlite");
    const legacyCodex = {
      source: "npm",
      spec: "@openclaw/codex@2026.5.20",
      installPath: "/state/npm/node_modules/@openclaw/codex",
      version: "2026.5.20",
      integrity: "sha512-legacy",
    };
    writeJson(legacyPath, {
      version: 1,
      hostContractVersion: "2026.5.20",
      compatRegistryVersion: "legacy",
      migrationVersion: 1,
      policyHash: "legacy",
      generatedAtMs: 1,
      installRecords: {
        codex: legacyCodex,
        slack: {
          source: "npm",
          spec: "@openclaw/slack@2026.5.20",
          installPath: "/state/npm/node_modules/@openclaw/slack",
          version: "2026.5.20",
        },
      },
      plugins: [],
      diagnostics: [],
    });
    createPluginIndexDatabase({
      databasePath,
      installRecords: {
        codex: {
          source: "npm",
          spec: "@openclaw/codex@2026.7.1",
          installPath: "/state/npm/node_modules/@openclaw/codex",
          version: "2026.7.1",
          resolvedName: "@openclaw/codex",
          resolvedVersion: "2026.7.1",
          resolvedSpec: "@openclaw/codex@2026.7.1",
        },
        slack: {
          source: "npm",
          spec: "@openclaw/slack@2026.7.1",
          installPath: "/state/npm/node_modules/@openclaw/slack",
          version: "2026.7.1",
          resolvedName: "@openclaw/slack",
          resolvedVersion: "2026.7.1",
          resolvedSpec: "@openclaw/slack@2026.7.1",
        },
        searxng: {
          source: "npm",
          spec: "@openclaw/searxng-plugin@2026.7.1",
          resolvedName: "@openclaw/searxng-plugin",
          resolvedVersion: "2026.7.1",
        },
      },
    });

    expect(
      inspectPluginIndexConflict({ openclawDir }).conflictingPluginIds,
    ).toEqual(["codex", "slack"]);

    const result = runAlphaclawMigrations({
      rootDir,
      openclawDir,
      fix: true,
      now: new Date("2026-07-17T18:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(
      result.results.find(
        (entry) =>
          entry.id === "2026-07-repair-openclaw-plugin-index-conflicts",
      ),
    ).toMatchObject({ status: "fixed" });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare("SELECT * FROM installed_plugin_index WHERE index_key = ?")
      .get("installed-plugin-index");
    database.close();
    expect(row).toBeUndefined();

    const nextLegacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    expect(nextLegacy.installRecords.codex).toEqual(legacyCodex);
    expect(nextLegacy.installRecords.searxng).toMatchObject({
      resolvedName: "@openclaw/searxng-plugin",
    });
    const backupPath = path.join(
      rootDir,
      "migrations",
      "openclaw-plugin-index-conflict-20260717T180000000Z.json",
    );
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(inspectPluginIndexConflict({ openclawDir }).pending).toBe(false);
  });

  it("reports a lingering legacy plugin index as a startup blocker", () => {
    const legacyPath = path.join(openclawDir, "plugins", "installs.json");
    writeJson(legacyPath, { installRecords: {} });

    expect(inspectOpenclawStartupState({ openclawDir })).toEqual({
      ok: false,
      blockers: [
        {
          type: "legacy-plugin-index",
          path: legacyPath,
          message:
            "OpenClaw legacy plugin install index is still present after doctor.",
        },
      ],
    });
  });
});
