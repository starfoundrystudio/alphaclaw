// Resolves the agent that should own first-run/default interactions: the
// explicitly flagged default, else the conventional "main" agent, else the
// first configured agent, else the OpenClaw fallback id.
const resolveDefaultAgentId = (cfg) => {
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const explicitDefault = agents.find((entry) => !!entry?.default);
  const explicitId = String(explicitDefault?.id || "").trim();
  if (explicitId) return explicitId;
  const mainAgent = agents.find(
    (entry) => String(entry?.id || "").trim() === "main",
  );
  if (mainAgent) return "main";
  const firstId = String(agents[0]?.id || "").trim();
  return firstId || "main";
};

const buildAgentMainSessionKey = (agentId = "") =>
  `agent:${String(agentId || "main").trim() || "main"}:main`;

module.exports = {
  resolveDefaultAgentId,
  buildAgentMainSessionKey,
};
