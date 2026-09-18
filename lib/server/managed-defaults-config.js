const kManagedCpxAgentMaxConcurrent = 3;

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const ensureObject = (parent, key) => {
  if (!isObject(parent[key])) parent[key] = {};
  return parent[key];
};

const ensureManagedOpenclawDefaults = (rawConfig = {}) => {
  const config = isObject(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);

  const agents = ensureObject(config, "agents");
  const agentDefaults = ensureObject(agents, "defaults");
  agentDefaults.maxConcurrent = kManagedCpxAgentMaxConcurrent;

  const plugins = ensureObject(config, "plugins");
  const pluginEntries = ensureObject(plugins, "entries");
  const memoryCore = ensureObject(pluginEntries, "memory-core");
  const memoryCoreConfig = ensureObject(memoryCore, "config");
  const dreaming = ensureObject(memoryCoreConfig, "dreaming");
  dreaming.enabled = false;

  const skills = ensureObject(config, "skills");
  const workshop = ensureObject(skills, "workshop");
  const autonomous = ensureObject(workshop, "autonomous");
  autonomous.mode = "propose";

  const tools = ensureObject(config, "tools");
  if (isObject(tools.swarm)) {
    tools.swarm.enabled = false;
  } else {
    tools.swarm = false;
  }
  const deniedTools = Array.isArray(tools.deny) ? tools.deny.slice() : [];
  if (!deniedTools.includes("secrets")) deniedTools.push("secrets");
  tools.deny = deniedTools;

  const gateway = ensureObject(config, "gateway");
  ensureObject(gateway, "cliAgents").enabled = false;
  ensureObject(gateway, "terminal").enabled = false;

  ensureObject(config, "telemetry").enabled = false;
  const secrets = ensureObject(config, "secrets");
  ensureObject(secrets, "egressProxy").enabled = false;

  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const capManagedCpxAgentConcurrency = (rawConfig = {}) => {
  const config = isObject(rawConfig) ? rawConfig : {};
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const configured = Number(defaults.maxConcurrent);
  defaults.maxConcurrent =
    Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, kManagedCpxAgentMaxConcurrent)
      : kManagedCpxAgentMaxConcurrent;
  return defaults.maxConcurrent;
};

module.exports = {
  kManagedCpxAgentMaxConcurrent,
  capManagedCpxAgentConcurrency,
  ensureManagedOpenclawDefaults,
};
