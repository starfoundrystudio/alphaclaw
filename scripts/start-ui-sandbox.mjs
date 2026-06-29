#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startUiSandboxServer } = require("../lib/server/ui-sandbox/server.js");

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const flagValue = (...flags) => {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  }
  return "";
};

const mode =
  flagValue("--mode") ||
  process.env.ALPHACLAW_UI_SANDBOX_MODE ||
  (hasFlag("--setup") ? "setup" : "dashboard");
const port = Number(flagValue("--port") || process.env.PORT || 3001);
const scenario =
  flagValue("--scenario") ||
  process.env.ALPHACLAW_UI_SCENARIO ||
  (mode === "setup" ? "setup" : "healthy");
const persist =
  hasFlag("--persist") ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.ALPHACLAW_UI_SANDBOX_PERSIST || "").toLowerCase(),
  );
const realClaudeCli =
  hasFlag("--real-claude-cli") ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.ALPHACLAW_UI_SANDBOX_REAL_CLAUDE_CLI || "").toLowerCase(),
  );
const realClaudeCliHome =
  flagValue("--real-claude-cli-home") ||
  process.env.ALPHACLAW_UI_SANDBOX_REAL_CLAUDE_CLI_HOME ||
  "";
const workspaceRoot =
  flagValue("--workspace-root") || process.env.ALPHACLAW_UI_SANDBOX_ROOT || "";

startUiSandboxServer({
  mode,
  scenario,
  port,
  persist,
  workspaceRoot,
  realClaudeCli,
  realClaudeCliHome,
});
