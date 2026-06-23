const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGit = (cwd, args) => {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const createSqliteDb = (dbPath) => {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO events (kind, status, created_at)
          VALUES ('webhook', 'success', '2026-06-22T10:00:00Z'),
                 ('cron', 'queued', '2026-06-22T11:00:00Z');
      `);
    } finally {
      db.close();
    }
  } catch {
    writeFile(dbPath, "");
  }
};

const seedWorkspace = (workspaceDir) => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeFile(
    path.join(workspaceDir, "openclaw.json"),
    JSON.stringify(
      {
        models: { default: "anthropic/claude-opus-4-8" },
        agents: {
          main: { model: "anthropic/claude-opus-4-8" },
          research: { model: "google/gemini-3-1-pro-preview" },
        },
        gateway: { port: 18789 },
      },
      null,
      2,
    ),
  );
  writeFile(
    path.join(workspaceDir, ".env.example"),
    [
      "ANTHROPIC_API_KEY=sk-ant-sandbox",
      "ALPHACLAW_SETUP_URL=http://localhost:3001",
      "TELEGRAM_BOT_TOKEN=123456:sandbox",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(workspaceDir, "README.md"),
    [
      "# AlphaClaw UI Sandbox",
      "",
      "This workspace is synthetic and safe to edit.",
      "",
      "- Try the markdown preview.",
      "- Open diffs from the Git panel.",
      "- Inspect the SQLite sample database.",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(workspaceDir, "workspace", "notes", "daily-brief.md"),
    [
      "---",
      "title: Daily Brief",
      "owner: main",
      "---",
      "",
      "Review webhook errors, usage trends, and pending automation work.",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(workspaceDir, "workspace", "config", "routing.json"),
    JSON.stringify(
      {
        defaultAgent: "main",
        destinations: [{ channel: "telegram", accountId: "sandbox" }],
      },
      null,
      2,
    ),
  );
  writeFile(
    path.join(workspaceDir, "webhooks", "deploy-events", "transform.js"),
    [
      "export default async function transform(payload) {",
      "  return {",
      "    message: `Deploy event: ${payload.service || 'unknown'}`,",
      "    wakeMode: 'now',",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(workspaceDir, "logs", "process.log"),
    [
      "[sandbox] AlphaClaw UI sandbox booted",
      "[sandbox] Gateway health check synthetic: healthy",
      "",
    ].join("\n"),
  );
  createSqliteDb(path.join(workspaceDir, "db", "usage.db"));

  if (runGit(workspaceDir, ["init", "-b", "main"])) {
    runGit(workspaceDir, ["config", "user.email", "sandbox@alphaclaw.local"]);
    runGit(workspaceDir, ["config", "user.name", "AlphaClaw Sandbox"]);
    runGit(workspaceDir, ["add", "."]);
    runGit(workspaceDir, ["commit", "-m", "Initial sandbox workspace"]);
    writeFile(
      path.join(workspaceDir, "workspace", "notes", "daily-brief.md"),
      [
        "---",
        "title: Daily Brief",
        "owner: main",
        "---",
        "",
        "Review webhook errors, usage trends, and pending automation work.",
        "",
        "This line is intentionally modified for diff testing.",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(workspaceDir, "workspace", "notes", "scratch.md"),
      "# Scratch\n\nThis untracked file is here for Git panel testing.\n",
    );
  }
};

const prepareSandboxWorkspace = ({ persist = false, rootDir = "" } = {}) => {
  const baseDir =
    rootDir ||
    path.join(os.tmpdir(), "alphaclaw-ui-sandbox");
  const workspaceDir = path.join(baseDir, ".openclaw");
  if (!persist || !fs.existsSync(workspaceDir)) {
    seedWorkspace(workspaceDir);
  }
  return { baseDir, workspaceDir };
};

module.exports = {
  prepareSandboxWorkspace,
  seedWorkspace,
};
