const path = require("path");

const importPortableAuthStores = ({ fs, openclawDir, authProfiles }) => {
  const agentsDir = path.join(openclawDir, "agents");
  let importedAgentCount = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { importedAgentCount };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storePath = path.join(agentsDir, entry.name, "agent", "auth-profiles.json");
    if (!fs.existsSync(storePath)) continue;
    authProfiles.syncConfigAuthReferencesForAgent(entry.name);
    importedAgentCount += 1;
  }
  return { importedAgentCount };
};

module.exports = { importPortableAuthStores };
