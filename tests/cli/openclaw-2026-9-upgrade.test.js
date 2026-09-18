const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const kRepoRoot = path.resolve(__dirname, "../..");
const kAlphaclawBin = path.join(kRepoRoot, "bin", "alphaclaw.js");
const kOpenclawBin = path.join(
  kRepoRoot,
  "node_modules",
  "openclaw",
  "openclaw.mjs",
);

const readStateCell = (databasePath, stateKey) => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = ?",
      )
      .get(stateKey);
    return row?.value_json ? JSON.parse(row.value_json) : null;
  } finally {
    db.close();
  }
};

describe("OpenClaw 2026.9 existing-instance upgrade", () => {
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "alphaclaw-openclaw-2026-9-upgrade-"),
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    "runs guarded Doctor over a 2026.7.1 roster and shared-auth fixture",
    () => {
      const openclawDir = path.join(rootDir, ".openclaw");
      const configPath = path.join(openclawDir, "openclaw.json");
      const agentDir = path.join(openclawDir, "agents", "main", "agent");
      const agentDatabasePath = path.join(agentDir, "openclaw-agent.sqlite");
      const stateDatabasePath = path.join(
        openclawDir,
        "state",
        "openclaw.sqlite",
      );
      const originalCredential = {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 1_700_000_000_000,
        email: "fixture@example.com",
      };

      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local" },
            agents: {
              defaults: { workspace: path.join(rootDir, "workspace") },
              list: [{ id: "main", default: true, name: "Main" }],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const agentDb = new DatabaseSync(agentDatabasePath);
      agentDb.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE auth_profile_state (
          state_key TEXT NOT NULL PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      agentDb
        .prepare("INSERT INTO schema_meta VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("primary", "agent", 1, "main", null, 1_700_000_000_000, 1_700_000_000_000);
      agentDb
        .prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)")
        .run(
          "primary",
          JSON.stringify({
            version: 1,
            profiles: { "openai:fixture@example.com": originalCredential },
          }),
          1_700_000_000_000,
        );
      agentDb
        .prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)")
        .run("primary", JSON.stringify({ version: 1 }), 1_700_000_000_000);
      agentDb.close();

      const result = spawnSync(
        process.execPath,
        [
          kAlphaclawBin,
          "--root-dir",
          rootDir,
          "openclaw-doctor-guard",
          "--",
          process.execPath,
          kOpenclawBin,
          "doctor",
          "--non-interactive",
          "--fix",
        ],
        {
          cwd: kRepoRoot,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: rootDir,
            CODEX_HOME: path.join(rootDir, ".codex"),
            GH_CONFIG_DIR: path.join(rootDir, ".config", "gh"),
            SETUP_PASSWORD: "",
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(
        "Relocated shared auth profiles into shared SQLite state.",
      );
      expect(result.stdout).toContain("Doctor complete.");
      expect(result.stdout).toContain(
        "Restored 1 OAuth profile(s) after OpenClaw doctor",
      );

      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.agents.list).toBeUndefined();
      expect(config.agents.entries).toEqual({ main: { name: "Main" } });
      expect(readStateCell(stateDatabasePath, "auth.sharedStore")).toEqual({
        location: "state-db",
      });
      expect(readStateCell(stateDatabasePath, "authProfiles.store")).toEqual({
        version: 1,
        profiles: {
          "openai:fixture@example.com": originalCredential,
        },
      });

      const migratedAgentDb = new DatabaseSync(agentDatabasePath, {
        readOnly: true,
      });
      const legacyRow = migratedAgentDb
        .prepare(
          "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        )
        .get("primary");
      migratedAgentDb.close();
      expect(legacyRow).toBeUndefined();
      expect(
        fs.readdirSync(path.join(openclawDir, "locks", "oauth-refresh")),
      ).toEqual([]);
    },
    35_000,
  );
});
