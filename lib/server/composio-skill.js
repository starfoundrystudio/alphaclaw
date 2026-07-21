const path = require("path");
const { readGoogleState, resolveGoogleProvider } = require("./google-state");
const {
  composioStatePath,
  readComposioState,
  normalizeComposioState,
  listGoogleWorkspaceAccounts,
} = require("./composio-state");

const kSkillPartsDir = path.join(__dirname, "..", "setup", "skills", "composio");

const kToolkitDisplayNames = {
  gmail: "Gmail",
  googlecalendar: "Calendar",
  googledrive: "Drive",
  googlesheets: "Sheets",
  googledocs: "Docs",
  googletasks: "Tasks",
  googlemeet: "Meet",
};

// Stable ordering for toolkit sections
const kToolkitOrder = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googlesheets",
  "googledocs",
  "googletasks",
  "googlemeet",
];

const readSkillPart = (fs, name) => {
  try {
    return fs.readFileSync(path.join(kSkillPartsDir, `${name}.md`), "utf8");
  } catch {
    return null;
  }
};

const buildComposioSkillContent = ({ fs, composioState }) => {
  const normalized = normalizeComposioState(composioState || {});
  if (!normalized.cliInstalled) return null;

  const googleAccounts = listGoogleWorkspaceAccounts(normalized);
  const connectedToolkits = new Set(
    googleAccounts.map((account) => account.toolkit),
  );
  const toolkitNames = kToolkitOrder
    .filter((toolkit) => connectedToolkits.has(toolkit))
    .map((toolkit) => kToolkitDisplayNames[toolkit] || toolkit);

  const lines = [];

  lines.push("---");
  lines.push("name: composio");
  lines.push(
    toolkitNames.length
      ? `description: Composio CLI — managed integrations, currently linked to Google Workspace (${toolkitNames.join(", ")}).`
      : "description: Composio CLI — managed integrations for Google Workspace and other apps.",
  );
  lines.push("---");
  lines.push("");
  lines.push("# composio — managed app integrations");
  lines.push("");
  lines.push(
    "This deployment uses the Composio CLI for Google Workspace (and potentially other apps). Composio hosts the OAuth apps and refreshes tokens automatically.",
  );
  lines.push("");

  const usage = readSkillPart(fs, "usage");
  if (usage) {
    lines.push(usage.trimEnd());
    lines.push("");
  }

  lines.push("## Linked Google Workspace Accounts");
  lines.push("");
  if (googleAccounts.length) {
    lines.push("| Toolkit | Account ID | Label | Status |");
    lines.push("| ------- | ---------- | ----- | ------ |");
    for (const account of googleAccounts) {
      const toolkit = kToolkitDisplayNames[account.toolkit] || account.toolkit;
      lines.push(
        `| ${toolkit} (\`${account.toolkit}\`) | ${account.id || "(unknown)"} | ${account.label || "—"} | ${account.status || "ACTIVE"} |`,
      );
    }
  } else {
    lines.push(
      "No Google Workspace accounts are linked yet. Link one with `composio connected-accounts link <toolkit>` (e.g. `gmail`, `googlecalendar`), or run `composio connected-accounts list` to re-check.",
    );
  }
  lines.push("");

  for (const toolkit of kToolkitOrder) {
    if (!connectedToolkits.has(toolkit)) continue;
    const section = readSkillPart(fs, toolkit);
    if (section) {
      lines.push(section.trimEnd());
      lines.push("");
    }
  }

  return lines.join("\n");
};

const installComposioSkill = ({ fs, openclawDir }) => {
  try {
    const googleState = readGoogleState({
      fs,
      statePath: path.join(openclawDir, "gogcli", "state.json"),
    });
    const skillDir = path.join(openclawDir, "skills", "composio");
    const skillPath = path.join(skillDir, "SKILL.md");

    const removeSkillIfPresent = (reason) => {
      if (fs.existsSync(skillPath)) {
        fs.unlinkSync(skillPath);
        console.log(`[composio-skill] Removed composio skill (${reason})`);
      }
    };

    const { provider } = resolveGoogleProvider({ state: googleState });
    if (provider !== "composio") {
      removeSkillIfPresent(`google provider is "${provider}"`);
      return;
    }

    const composioState = readComposioState({
      fs,
      statePath: composioStatePath(openclawDir),
    });
    const content = buildComposioSkillContent({ fs, composioState });
    if (!content) {
      removeSkillIfPresent("composio CLI not installed");
      return;
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, content);
    console.log("[composio-skill] composio skill installed");
  } catch (e) {
    console.error("[composio-skill] Install error:", e.message);
  }
};

module.exports = { buildComposioSkillContent, installComposioSkill };
