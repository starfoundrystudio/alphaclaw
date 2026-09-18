const {
  kManagedCapabilityContract,
} = require("./managed-capability-contract");

const kManagedInitialDefaults =
  kManagedCapabilityContract.managedConfig.initialDefaults;
const kManagedCpxAgentMaxConcurrent =
  kManagedInitialDefaults.agents.defaults.maxConcurrent;

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
  dreaming.enabled =
    kManagedInitialDefaults.plugins.entries["memory-core"].config.dreaming.enabled;

  const skills = ensureObject(config, "skills");
  const workshop = ensureObject(skills, "workshop");
  const autonomous = ensureObject(workshop, "autonomous");
  autonomous.mode = kManagedInitialDefaults.skills.workshop.autonomous.mode;

  const tools = ensureObject(config, "tools");
  if (isObject(tools.swarm)) {
    tools.swarm.enabled = kManagedInitialDefaults.tools.swarm;
  } else {
    tools.swarm = kManagedInitialDefaults.tools.swarm;
  }
  const deniedTools = Array.isArray(tools.deny) ? tools.deny.slice() : [];
  for (const deniedTool of kManagedInitialDefaults.tools.deny) {
    if (!deniedTools.includes(deniedTool)) deniedTools.push(deniedTool);
  }
  tools.deny = deniedTools;

  const gateway = ensureObject(config, "gateway");
  ensureObject(gateway, "cliAgents").enabled =
    kManagedInitialDefaults.gateway.cliAgents.enabled;
  ensureObject(gateway, "terminal").enabled =
    kManagedInitialDefaults.gateway.terminal.enabled;

  ensureObject(config, "telemetry").enabled =
    kManagedInitialDefaults.telemetry.enabled;
  const secrets = ensureObject(config, "secrets");
  ensureObject(secrets, "egressProxy").enabled =
    kManagedInitialDefaults.secrets.egressProxy.enabled;

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
