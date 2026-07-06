const path = require("path");
const {
  readOpenclawConfig,
  writeOpenclawConfig,
} = require("./openclaw-config");

const kManagedActiveMemoryPluginId = "active-memory";
const kManagedTeamyouMemoryPluginId = "openclaw-teamyou-memory";
const kManagedTeamyouSkillId = "teamyou";
const kManagedMemorySlotPluginIds = new Set([
  kManagedActiveMemoryPluginId,
  kManagedTeamyouMemoryPluginId,
]);
const kDisabledMemorySlot = "none";
const kWorkspaceStateFileName = "openclaw-workspace-state.json";
const kBootstrapFileName = "BOOTSTRAP.md";
const kActivationMarkerRelativePath = path.join(
  ".alphaclaw",
  "teamyou-memory-activated.json",
);
const kDefaultActivationPollMs = 30 * 1000;

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readJsonFile = ({ fsModule, filePath }) => {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const getActivationMarkerPath = ({ openclawDir }) =>
  path.join(openclawDir, kActivationMarkerRelativePath);

const writeActivationMarker = ({
  fsModule,
  openclawDir,
  pluginId,
  workspaceDir,
  reason,
}) => {
  const markerPath = getActivationMarkerPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(markerPath), { recursive: true });
  fsModule.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        activated: true,
        pluginId,
        workspaceDir,
        reason,
        markedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
};

// Files OpenClaw seeds into a brand-new workspace alongside BOOTSTRAP.md.
// Their presence without BOOTSTRAP.md means the ritual ran and removed it.
const kSeededWorkspaceEvidenceFiles = ["IDENTITY.md", "AGENTS.md", "USER.md"];

const isWorkspaceBootstrapComplete = ({ fsModule, workspaceDir }) => {
  const normalizedWorkspaceDir = String(workspaceDir || "").trim();
  if (!normalizedWorkspaceDir || !fsModule.existsSync(normalizedWorkspaceDir)) {
    return {
      complete: false,
      reason: "workspace_missing",
      workspaceDir: normalizedWorkspaceDir,
    };
  }

  const state = readJsonFile({
    fsModule,
    filePath: path.join(normalizedWorkspaceDir, kWorkspaceStateFileName),
  });
  if (String(state?.setupCompletedAt || "").trim()) {
    return {
      complete: true,
      reason: "setup_completed_marker",
      workspaceDir: normalizedWorkspaceDir,
    };
  }

  const bootstrapPath = path.join(normalizedWorkspaceDir, kBootstrapFileName);
  if (fsModule.existsSync(bootstrapPath)) {
    return {
      complete: false,
      reason: "bootstrap_pending",
      workspaceDir: normalizedWorkspaceDir,
    };
  }

  const workspaceWasSeeded =
    !!String(state?.bootstrapSeededAt || "").trim() ||
    kSeededWorkspaceEvidenceFiles.some((fileName) =>
      fsModule.existsSync(path.join(normalizedWorkspaceDir, fileName)),
    );
  if (workspaceWasSeeded) {
    return {
      complete: true,
      reason: "bootstrap_file_absent",
      workspaceDir: normalizedWorkspaceDir,
    };
  }

  // The workspace directory exists but OpenClaw has not seeded it yet, so a
  // missing BOOTSTRAP.md is "not started" rather than "finished".
  return {
    complete: false,
    reason: "workspace_not_seeded",
    workspaceDir: normalizedWorkspaceDir,
  };
};

const collectWorkspaceCandidates = ({ cfg = {}, workspaceDir }) => {
  const candidates = [];
  const add = (value) => {
    const normalized = String(value || "").trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  add(cfg.agents?.defaults?.workspace);
  const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const defaultAgent =
    configuredAgents.find((agent) => agent?.default === true) ||
    configuredAgents.find((agent) => String(agent?.id || "").trim() === "main") ||
    configuredAgents[0];
  add(defaultAgent?.workspace);
  add(workspaceDir);
  return candidates;
};

const ensurePluginsShell = (cfg) => {
  if (!cfg.plugins || typeof cfg.plugins !== "object") cfg.plugins = {};
  if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
  if (!isPlainObject(cfg.plugins.entries)) cfg.plugins.entries = {};
  if (!isPlainObject(cfg.plugins.slots)) cfg.plugins.slots = {};
};

const ensureSkillsShell = (cfg) => {
  if (!cfg.skills || typeof cfg.skills !== "object" || Array.isArray(cfg.skills)) {
    cfg.skills = {};
  }
  if (
    !cfg.skills.entries ||
    typeof cfg.skills.entries !== "object" ||
    Array.isArray(cfg.skills.entries)
  ) {
    cfg.skills.entries = {};
  }
};

const ensurePluginAllowed = ({ cfg, pluginId }) => {
  if (!cfg.plugins.allow.includes(pluginId)) cfg.plugins.allow.push(pluginId);
};

const hasManagedTeamyouMemoryConfig = (cfg) =>
  cfg.plugins.allow.includes(kManagedTeamyouMemoryPluginId) ||
  isPlainObject(cfg.plugins.entries[kManagedTeamyouMemoryPluginId]) ||
  String(cfg.plugins.slots.memory || "").trim() === kManagedTeamyouMemoryPluginId;

const hasManagedTeamyouSkillConfig = (cfg, skillId = kManagedTeamyouSkillId) =>
  isPlainObject(cfg.skills?.entries?.[skillId]);

const hasManagedTeamyouConfig = (cfg, skillId = kManagedTeamyouSkillId) =>
  hasManagedTeamyouMemoryConfig(cfg) || hasManagedTeamyouSkillConfig(cfg, skillId);

const ensureActiveMemoryConfigEnabled = ({ cfg, enabled }) => {
  const entry = isPlainObject(cfg.plugins.entries[kManagedActiveMemoryPluginId])
    ? cfg.plugins.entries[kManagedActiveMemoryPluginId]
    : {};
  const config = isPlainObject(entry.config) ? entry.config : {};
  cfg.plugins.entries[kManagedActiveMemoryPluginId] = {
    ...entry,
    enabled: true,
    config: {
      ...config,
      enabled,
    },
  };
};

const ensureTeamyouSkillEnabled = ({ cfg, enabled, skillId = kManagedTeamyouSkillId }) => {
  ensureSkillsShell(cfg);
  const entry = isPlainObject(cfg.skills.entries[skillId])
    ? cfg.skills.entries[skillId]
    : {};
  cfg.skills.entries[skillId] = {
    ...entry,
    enabled,
  };
};

const writeManagedConfig = ({ fsModule, openclawDir, cfg, memorySlot }) => {
  cfg.plugins.slots.memory = memorySlot;
  writeOpenclawConfig({ fsModule, openclawDir, config: cfg });
};

const resolveBootstrapCompletion = ({ fsModule, cfg, workspaceDir }) => {
  const workspaceCandidates = collectWorkspaceCandidates({ cfg, workspaceDir });
  return workspaceCandidates
    .map((candidate) =>
      isWorkspaceBootstrapComplete({
        fsModule,
        workspaceDir: candidate,
      }),
    )
    .find((candidate) => candidate.complete || candidate.reason !== "workspace_missing") || {
    complete: false,
    reason: "workspace_missing",
    workspaceDir: "",
  };
};

const enforceTeamyouBootstrapGateIfPending = ({
  fsModule,
  openclawDir,
  workspaceDir,
  pluginId = kManagedTeamyouMemoryPluginId,
  skillId = kManagedTeamyouSkillId,
} = {}) => {
  if (!fsModule) throw new Error("fsModule is required");
  if (!openclawDir) throw new Error("openclawDir is required");

  const cfg = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  ensurePluginsShell(cfg);
  ensureSkillsShell(cfg);

  const memoryConfigured = hasManagedTeamyouMemoryConfig(cfg);
  const skillConfigured = hasManagedTeamyouSkillConfig(cfg, skillId);
  const shouldManageSkill = memoryConfigured || skillConfigured;
  if (!memoryConfigured && !skillConfigured) {
    return {
      ok: true,
      changed: false,
      reason: "teamyou_not_configured",
    };
  }

  const completion = resolveBootstrapCompletion({ fsModule, cfg, workspaceDir });
  if (completion.complete) {
    return {
      ok: true,
      changed: false,
      reason: completion.reason,
      workspaceDir: completion.workspaceDir,
    };
  }

  const memorySlot = String(cfg.plugins.slots.memory || "").trim();
  const activeMemoryConfig = cfg.plugins.entries[kManagedActiveMemoryPluginId]?.config;
  const activeMemoryEnabled =
    !isPlainObject(activeMemoryConfig) || activeMemoryConfig.enabled !== false;
  const teamyouSkillConfig = cfg.skills.entries[skillId];
  const teamyouSkillEnabled =
    !isPlainObject(teamyouSkillConfig) || teamyouSkillConfig.enabled !== false;
  const managedSlotLeaked = memoryConfigured && kManagedMemorySlotPluginIds.has(memorySlot);
  const activeMemoryLeaked = memoryConfigured && activeMemoryEnabled;
  const teamyouSkillLeaked = shouldManageSkill && teamyouSkillEnabled;

  if (!managedSlotLeaked && !activeMemoryLeaked && !teamyouSkillLeaked) {
    return {
      ok: true,
      changed: false,
      reason: completion.reason,
      memorySlot,
      activeMemoryEnabled,
      teamyouSkillEnabled,
      workspaceDir: completion.workspaceDir,
    };
  }

  if (memoryConfigured) {
    ensureActiveMemoryConfigEnabled({ cfg, enabled: false });
  }
  if (shouldManageSkill) {
    ensureTeamyouSkillEnabled({ cfg, enabled: false, skillId });
  }
  writeManagedConfig({
    fsModule,
    openclawDir,
    cfg,
    memorySlot: memoryConfigured ? kDisabledMemorySlot : memorySlot,
  });
  return {
    ok: true,
    changed: true,
    reason: completion.reason,
    previousMemorySlot: memorySlot,
    previousActiveMemoryEnabled: activeMemoryEnabled,
    previousTeamyouSkillEnabled: teamyouSkillEnabled,
    memorySlot: memoryConfigured ? kDisabledMemorySlot : memorySlot,
    activeMemoryEnabled: memoryConfigured ? false : activeMemoryEnabled,
    teamyouSkillEnabled: shouldManageSkill ? false : teamyouSkillEnabled,
    workspaceDir: completion.workspaceDir,
    pluginId,
    skillId,
  };
};

const activateTeamyouMemoryIfBootstrapComplete = async ({
  fsModule,
  openclawDir,
  workspaceDir,
  restartGateway,
  logger = console,
  pluginId = kManagedTeamyouMemoryPluginId,
  skillId = kManagedTeamyouSkillId,
} = {}) => {
  if (!fsModule) throw new Error("fsModule is required");
  if (!openclawDir) throw new Error("openclawDir is required");

  const cfg = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  ensurePluginsShell(cfg);
  ensureSkillsShell(cfg);

  const memoryConfigured = hasManagedTeamyouMemoryConfig(cfg);
  const skillConfigured = hasManagedTeamyouSkillConfig(cfg, skillId);
  const shouldManageSkill = memoryConfigured || skillConfigured;

  if (!hasManagedTeamyouConfig(cfg, skillId)) {
    return {
      ok: true,
      activated: false,
      reason: "teamyou_not_configured",
    };
  }

  const completion = resolveBootstrapCompletion({ fsModule, cfg, workspaceDir });

  const memorySlot = String(cfg.plugins.slots.memory || "").trim();
  const activeMemoryConfig = cfg.plugins.entries[kManagedActiveMemoryPluginId]?.config;
  const activeMemoryEnabled =
    !isPlainObject(activeMemoryConfig) || activeMemoryConfig.enabled !== false;
  const teamyouSkillConfig = cfg.skills.entries[skillId];
  const teamyouSkillEnabled =
    !isPlainObject(teamyouSkillConfig) || teamyouSkillConfig.enabled !== false;
  const managedSlotLeaked = memoryConfigured && kManagedMemorySlotPluginIds.has(memorySlot);
  const activeMemoryLeaked = memoryConfigured && activeMemoryEnabled;
  const teamyouSkillLeaked = shouldManageSkill && teamyouSkillEnabled;
  if (!completion.complete && (managedSlotLeaked || activeMemoryLeaked || teamyouSkillLeaked)) {
    if (memoryConfigured) {
      ensureActiveMemoryConfigEnabled({ cfg, enabled: false });
    }
    if (shouldManageSkill) {
      ensureTeamyouSkillEnabled({ cfg, enabled: false, skillId });
    }
    writeManagedConfig({
      fsModule,
      openclawDir,
      cfg,
      memorySlot: kDisabledMemorySlot,
    });
    if (typeof restartGateway === "function") {
      await restartGateway();
    }
    return {
      ok: true,
      activated: false,
      repaired: true,
      reason: completion.reason,
      previousMemorySlot: memorySlot,
      previousActiveMemoryEnabled: activeMemoryEnabled,
      previousTeamyouSkillEnabled: teamyouSkillEnabled,
      memorySlot: kDisabledMemorySlot,
      activeMemoryEnabled: memoryConfigured ? false : activeMemoryEnabled,
      teamyouSkillEnabled: shouldManageSkill ? false : teamyouSkillEnabled,
      workspaceDir: completion.workspaceDir,
    };
  }

  if (
    memoryConfigured &&
    memorySlot &&
    memorySlot !== kDisabledMemorySlot
  ) {
    if (!completion.complete) {
      // An unmanaged memory slot (e.g. a user-picked backend) stays untouched,
      // but the watcher keeps polling so the TeamYou skill still activates
      // once bootstrap completes.
      return {
        ok: true,
        activated: false,
        reason: completion.reason,
        memorySlot,
        workspaceDir: completion.workspaceDir,
      };
    }
    const teamyouSkillAlreadyEnabled =
      isPlainObject(cfg.skills.entries[skillId]) &&
      cfg.skills.entries[skillId].enabled !== false;
    if (shouldManageSkill && !teamyouSkillAlreadyEnabled) {
      ensureTeamyouSkillEnabled({ cfg, enabled: true, skillId });
      writeManagedConfig({ fsModule, openclawDir, cfg, memorySlot });
      writeActivationMarker({
        fsModule,
        openclawDir,
        pluginId: memorySlot,
        workspaceDir: completion.workspaceDir,
        reason: "memory_slot_already_active",
      });
      if (typeof restartGateway === "function") {
        await restartGateway();
      }
      return {
        ok: true,
        activated: true,
        reason: "memory_slot_already_active",
        memorySlot,
        teamyouSkillEnabled: true,
        workspaceDir: completion.workspaceDir,
      };
    }
    writeActivationMarker({
      fsModule,
      openclawDir,
      pluginId: memorySlot,
      workspaceDir: "",
      reason: "memory_slot_already_active",
    });
    return {
      ok: true,
      activated: false,
      reason: "memory_slot_already_active",
      memorySlot,
    };
  }

  if (!completion.complete) {
    return {
      ok: true,
      activated: false,
      reason: completion.reason,
      workspaceDir: completion.workspaceDir,
    };
  }

  if (memoryConfigured) {
    const entry = isPlainObject(cfg.plugins.entries[pluginId])
      ? cfg.plugins.entries[pluginId]
      : {};
    ensurePluginAllowed({ cfg, pluginId });
    cfg.plugins.entries[pluginId] = {
      ...entry,
      enabled: true,
    };
    ensureActiveMemoryConfigEnabled({ cfg, enabled: true });
  }
  if (shouldManageSkill) {
    ensureTeamyouSkillEnabled({ cfg, enabled: true, skillId });
  }
  writeManagedConfig({
    fsModule,
    openclawDir,
    cfg,
    memorySlot: memoryConfigured ? pluginId : memorySlot,
  });
  writeActivationMarker({
    fsModule,
    openclawDir,
    pluginId,
    workspaceDir: completion.workspaceDir,
    reason: completion.reason,
  });

  if (typeof restartGateway === "function") {
    await restartGateway();
  }
  logger.log?.(
    `[alphaclaw] Activated TeamYou-backed memory after OpenClaw bootstrap (${completion.reason})`,
  );
  return {
    ok: true,
    activated: true,
    reason: completion.reason,
    memorySlot: memoryConfigured ? pluginId : memorySlot,
    teamyouSkillEnabled: shouldManageSkill ? true : teamyouSkillEnabled,
    workspaceDir: completion.workspaceDir,
  };
};

const createTeamyouMemoryActivationService = ({
  fsModule,
  openclawDir,
  workspaceDir,
  restartGateway,
  logger = console,
  intervalMs = kDefaultActivationPollMs,
  pluginId = kManagedTeamyouMemoryPluginId,
  skillId = kManagedTeamyouSkillId,
} = {}) => {
  let timer = null;
  let running = false;
  let stopped = false;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(1000, Number(intervalMs) || kDefaultActivationPollMs));
    if (typeof timer.unref === "function") timer.unref();
  };

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await activateTeamyouMemoryIfBootstrapComplete({
        fsModule,
        openclawDir,
        workspaceDir,
        restartGateway,
        logger,
        pluginId,
        skillId,
      });
      // Keep polling until activation actually happens. On a fresh provision
      // the TeamYou plugin/skill are installed out-of-band (clawctl's
      // post-onboard reconcile timer) after this service starts, so
      // "teamyou_not_configured" is a transient state, not a terminal one.
      if (!result.activated && result.reason !== "memory_slot_already_active") {
        schedule();
      }
    } catch (error) {
      logger.warn?.(
        `[alphaclaw] TeamYou memory activation check failed: ${error.message}`,
      );
      schedule();
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (stopped) stopped = false;
      void run();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    run,
  };
};

module.exports = {
  activateTeamyouMemoryIfBootstrapComplete,
  createTeamyouMemoryActivationService,
  enforceTeamyouBootstrapGateIfPending,
  isWorkspaceBootstrapComplete,
  resolveBootstrapCompletion,
  kDisabledMemorySlot,
  kManagedActiveMemoryPluginId,
  kManagedTeamyouMemoryPluginId,
  kManagedTeamyouSkillId,
};
