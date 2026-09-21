const { resolveDefaultAgentIdFromConfig } = require("./agents/shared");

// Resolves the agent that should own first-run/default interactions: a
// legacy default marker, else OpenClaw 2026.9's system agent, else the only
// agent, else "main", else the first configured agent.
const resolveDefaultAgentId = (cfg) => resolveDefaultAgentIdFromConfig(cfg);

const buildAgentMainSessionKey = (agentId = "") =>
  `agent:${String(agentId || "main").trim() || "main"}:main`;

module.exports = {
  resolveDefaultAgentId,
  buildAgentMainSessionKey,
};
