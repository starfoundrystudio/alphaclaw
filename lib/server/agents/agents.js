const path = require("path");
const { normalizeThinkingDefaultValue } = require("../openclaw-thinking");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");

const {
  kDefaultAgentId,
  resolveAgentWorkspacePath,
  loadConfig,
  saveConfig,
  cloneJson,
  getSafeStat,
  calculatePathSizeBytes,
  listAgentEntries,
  setAgentEntries,
  withNormalizedAgentsConfig,
  resolveDefaultAgentIdFromConfig,
  isValidAgentId,
  resolveRequestedWorkspacePath,
  ensureAgentScaffold,
} = require("./shared");

const toTitleWords = (value = "") =>
  String(value || "")
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const getFallbackAgentName = (agentId = "") => {
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId) return "Agent";
  const title = toTitleWords(normalizedAgentId) || normalizedAgentId;
  return `${title} Agent`;
};

const getAgentDisplayName = (agent = {}) =>
  String(agent?.identity?.name || "").trim() ||
  String(agent?.name || "").trim() ||
  getFallbackAgentName(agent?.id || "");

const toReadableAgent = (agent = {}, defaultAgentId = "") => ({
  ...agent,
  id: String(agent.id || "").trim(),
  name: getAgentDisplayName(agent),
  default: defaultAgentId
    ? String(agent.id || "").trim() === defaultAgentId
    : !!agent.default,
});

const normalizeStringList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );

const normalizeAgentModel = (value) => {
  if (typeof value === "string") {
    const primary = value.trim();
    if (!primary) throw new Error("Agent model primary is required");
    return primary;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid agent model configuration");
  }
  const primary = String(value.primary || "").trim();
  const fallbacks = normalizeStringList(value.fallbacks).filter(
    (entry) => entry !== primary,
  );
  if (!primary && fallbacks.length === 0) {
    throw new Error("Agent model primary or fallback is required");
  }
  return {
    ...(primary ? { primary } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
};

const createAgentsDomain = ({ fsImpl, OPENCLAW_DIR, clawCmd }) => {
  const readAgentsConfig = () =>
    withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });

  const getAgentDefaults = () => {
    const cfg = readAgentsConfig();
    const thinkingDefault = cfg.agents?.defaults?.thinkingDefault;
    const fastModeDefault = cfg.agents?.defaults?.fastModeDefault;
    const skills = cfg.agents?.defaults?.skills;
    return {
      thinkingDefault:
        typeof thinkingDefault === "string" && thinkingDefault.trim()
          ? thinkingDefault.trim()
          : null,
      fastModeDefault:
        fastModeDefault === true || fastModeDefault === false || fastModeDefault === "auto"
          ? fastModeDefault
          : null,
      skills: Array.isArray(skills) ? normalizeStringList(skills) : null,
    };
  };

  const listAgents = () => {
    const cfg = readAgentsConfig();
    const defaultAgentId = resolveDefaultAgentIdFromConfig(cfg);
    return listAgentEntries(cfg).map((entry) =>
      toReadableAgent(entry, defaultAgentId),
    );
  };

  const getAgent = (agentId) => {
    const normalized = String(agentId || "").trim();
    return listAgents().find((entry) => entry.id === normalized) || null;
  };

  const getAgentWorkspaceSize = (agentId) => {
    const normalized = String(agentId || "").trim();
    const agent = getAgent(normalized);
    if (!agent) throw new Error(`Agent "${normalized}" not found`);
    const workspacePath = String(
      agent.workspace ||
        resolveAgentWorkspacePath({ OPENCLAW_DIR, agentId: normalized }),
    ).trim();
    if (!workspacePath) {
      return { workspacePath: "", exists: false, sizeBytes: 0 };
    }
    const stat = getSafeStat({ fsImpl, targetPath: workspacePath });
    if (!stat) {
      return { workspacePath, exists: false, sizeBytes: 0 };
    }
    return {
      workspacePath,
      exists: true,
      sizeBytes: calculatePathSizeBytes({ fsImpl, targetPath: workspacePath }),
    };
  };

  const createAgent = (input = {}) => {
    const agentId = String(input.id || "").trim();
    if (!isValidAgentId(agentId)) {
      throw new Error(
        "Agent id must be lowercase letters, numbers, and hyphens only",
      );
    }

    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const agents = listAgentEntries(cfg);
    const existing = agents.find((entry) => entry.id === agentId);
    if (existing) {
      throw new Error(`Agent "${agentId}" already exists`);
    }

    const workspacePath = resolveRequestedWorkspacePath({
      OPENCLAW_DIR,
      agentId,
      workspaceFolder: input.workspaceFolder,
    });
    const { workspacePath: scaffoldWorkspacePath, agentDirPath } =
      ensureAgentScaffold({
        fsImpl,
        workspacePath,
        OPENCLAW_DIR,
        agentId,
      });
    const requestedIdentity =
      input.identity && typeof input.identity === "object"
        ? { ...input.identity }
        : {};
    const requestedName = String(input.name || "").trim();
    const identityName =
      requestedName ||
      String(requestedIdentity.name || "").trim() ||
      getFallbackAgentName(agentId);
    const nextAgent = {
      id: agentId,
      workspace: scaffoldWorkspacePath,
      agentDir: agentDirPath,
      identity: {
        ...requestedIdentity,
        name: identityName,
      },
      ...(input.model ? { model: input.model } : {}),
    };
    setAgentEntries(cfg, [...agents, nextAgent]);
    saveConfig({ fsImpl, OPENCLAW_DIR, config: cfg });
    return toReadableAgent(nextAgent, resolveDefaultAgentIdFromConfig(cfg));
  };

  const updateAgent = async (agentId, patch = {}) => {
    const normalized = String(agentId || "").trim();
    const cfg = readAgentsConfig();
    const agents = listAgentEntries(cfg);
    const index = agents.findIndex((entry) => entry.id === normalized);
    if (index < 0) throw new Error(`Agent "${normalized}" not found`);
    const current = agents[index];
    const next = { ...current };
    const identityPatched =
      patch.identity !== undefined || patch.name !== undefined;
    if (identityPatched) {
      const baseIdentity =
        patch.identity !== undefined
          ? patch.identity && typeof patch.identity === "object"
            ? { ...patch.identity }
            : {}
          : current.identity && typeof current.identity === "object"
            ? { ...current.identity }
            : {};
      const requestedName =
        patch.name !== undefined
          ? String(patch.name || "").trim()
          : String(baseIdentity.name || "").trim();
      const fallbackLegacyName = String(current.name || "").trim();
      baseIdentity.name =
        requestedName || fallbackLegacyName || getFallbackAgentName(normalized);
      next.identity = baseIdentity;
      // Only remove legacy top-level name once identity.name is persisted.
      delete next.name;
    }
    if (patch.model !== undefined) {
      if (patch.model === null) {
        delete next.model;
      } else {
        next.model = normalizeAgentModel(patch.model);
      }
    }
    if (patch.tools !== undefined) {
      if (patch.tools && typeof patch.tools === "object") {
        const toolsCfg = {};
        if (patch.tools.profile) toolsCfg.profile = String(patch.tools.profile);
        if (
          Array.isArray(patch.tools.alsoAllow) &&
          patch.tools.alsoAllow.length
        ) {
          toolsCfg.alsoAllow = patch.tools.alsoAllow.map(String);
        }
        if (Array.isArray(patch.tools.deny) && patch.tools.deny.length) {
          toolsCfg.deny = patch.tools.deny.map(String);
        }
        next.tools = toolsCfg;
      } else {
        delete next.tools;
      }
    }
    if (patch.thinkingDefault !== undefined) {
      if (patch.thinkingDefault === null) {
        delete next.thinkingDefault;
      } else {
        const normalizedThinking = await normalizeThinkingDefaultValue(
          patch.thinkingDefault,
        );
        if (!normalizedThinking) {
          throw new Error("Invalid thinkingDefault value");
        }
        next.thinkingDefault = normalizedThinking;
      }
    }
    if (patch.fastModeDefault !== undefined) {
      if (patch.fastModeDefault === null) {
        delete next.fastModeDefault;
      } else if (
        patch.fastModeDefault === true ||
        patch.fastModeDefault === false ||
        patch.fastModeDefault === "auto"
      ) {
        next.fastModeDefault = patch.fastModeDefault;
      } else {
        throw new Error("Invalid fastModeDefault value");
      }
    }
    if (patch.skills !== undefined) {
      if (patch.skills === null) {
        delete next.skills;
      } else if (Array.isArray(patch.skills)) {
        next.skills = normalizeStringList(patch.skills);
      } else {
        throw new Error("Agent skills must be an array or null");
      }
    }
    agents[index] = next;
    setAgentEntries(cfg, agents);
    saveConfig({ fsImpl, OPENCLAW_DIR, config: cfg });
    return toReadableAgent(next, resolveDefaultAgentIdFromConfig(cfg));
  };

  const getAgentSkills = async (agentId) => {
    const normalized = String(agentId || "").trim();
    if (!getAgent(normalized)) throw new Error(`Agent "${normalized}" not found`);
    if (typeof clawCmd !== "function") {
      throw new Error("OpenClaw skills command is unavailable");
    }
    const result = await clawCmd(
      `skills list --agent '${normalized.replace(/'/g, `'\\''`)}' --json`,
      { quiet: true, timeoutMs: 30000 },
    );
    if (!result?.ok) {
      throw new Error(
        result?.stderr || result?.stdout || "Could not load OpenClaw skills",
      );
    }
    const report = parseJsonObjectFromNoisyOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
    if (!report || !Array.isArray(report.skills)) {
      throw new Error("OpenClaw returned an invalid skills catalog");
    }
    return report;
  };

  const setDefaultAgent = (agentId) => {
    const normalized = String(agentId || "").trim();
    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const agents = listAgentEntries(cfg);
    const exists = agents.some((entry) => entry.id === normalized);
    if (!exists) throw new Error(`Agent "${normalized}" not found`);
    // OpenClaw 2026.9: the default agent is the system agent role; the
    // per-entry marker is retired (see resolveDefaultAgentIdFromConfig).
    const nextAgents = agents.map(({ default: _legacyMarker, ...entry }) => entry);
    setAgentEntries(cfg, nextAgents);
    cfg.agents.defaults = {
      ...(cfg.agents.defaults || {}),
      systemAgent: {
        ...(cfg.agents.defaults?.systemAgent || {}),
        agentId: normalized,
      },
    };
    saveConfig({ fsImpl, OPENCLAW_DIR, config: cfg });
    const target = nextAgents.find((entry) => entry.id === normalized);
    return target ? toReadableAgent(target, normalized) : null;
  };

  const deleteAgent = (agentId, { keepWorkspace = true } = {}) => {
    const normalized = String(agentId || "").trim();
    if (!normalized || normalized === kDefaultAgentId) {
      throw new Error("The default main agent cannot be deleted");
    }
    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const agents = listAgentEntries(cfg);
    const target = agents.find((entry) => entry.id === normalized);
    if (!target) throw new Error(`Agent "${normalized}" not found`);
    if (resolveDefaultAgentIdFromConfig(cfg) === normalized) {
      throw new Error("Default agent cannot be deleted");
    }
    setAgentEntries(
      cfg,
      agents.filter((entry) => entry.id !== normalized),
    );
    if (Array.isArray(cfg.bindings)) {
      cfg.bindings = cfg.bindings.filter(
        (binding) => String(binding?.agentId || "") !== normalized,
      );
    }
    saveConfig({ fsImpl, OPENCLAW_DIR, config: cfg });

    if (!keepWorkspace) {
      const workspacePath = String(
        target.workspace ||
          resolveAgentWorkspacePath({
            OPENCLAW_DIR,
            agentId: normalized,
          }),
      ).trim();
      const agentDirPath = path.join(OPENCLAW_DIR, "agents", normalized);
      if (workspacePath) {
        fsImpl.rmSync(workspacePath, { recursive: true, force: true });
      }
      fsImpl.rmSync(agentDirPath, { recursive: true, force: true });
    }
    return { ok: true };
  };

  return {
    listAgents,
    getAgent,
    getAgentDefaults,
    getAgentWorkspaceSize,
    createAgent,
    updateAgent,
    getAgentSkills,
    setDefaultAgent,
    deleteAgent,
  };
};

module.exports = { createAgentsDomain };
