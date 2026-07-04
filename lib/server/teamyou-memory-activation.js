const path = require("path");
const {
  readOpenclawConfig,
  writeOpenclawConfig,
} = require("./openclaw-config");

const kManagedActiveMemoryPluginId = "active-memory";
const kManagedTeamyouMemoryPluginId = "openclaw-teamyou-memory";
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
  if (!fsModule.existsSync(bootstrapPath)) {
    return {
      complete: true,
      reason: "bootstrap_file_absent",
      workspaceDir: normalizedWorkspaceDir,
    };
  }

  return {
    complete: false,
    reason: "bootstrap_pending",
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

const ensurePluginAllowed = ({ cfg, pluginId }) => {
  if (!cfg.plugins.allow.includes(pluginId)) cfg.plugins.allow.push(pluginId);
};

const writeMemorySlot = ({ fsModule, openclawDir, cfg, memorySlot }) => {
  cfg.plugins.slots.memory = memorySlot;
  writeOpenclawConfig({ fsModule, openclawDir, config: cfg });
};

const activateTeamyouMemoryIfBootstrapComplete = async ({
  fsModule,
  openclawDir,
  workspaceDir,
  restartGateway,
  logger = console,
  pluginId = kManagedTeamyouMemoryPluginId,
} = {}) => {
  if (!fsModule) throw new Error("fsModule is required");
  if (!openclawDir) throw new Error("openclawDir is required");

  const cfg = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  ensurePluginsShell(cfg);

  const workspaceCandidates = collectWorkspaceCandidates({ cfg, workspaceDir });
  const completion = workspaceCandidates
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

  const memorySlot = String(cfg.plugins.slots.memory || "").trim();
  if (!completion.complete && kManagedMemorySlotPluginIds.has(memorySlot)) {
    writeMemorySlot({
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
      memorySlot: kDisabledMemorySlot,
      workspaceDir: completion.workspaceDir,
    };
  }

  if (memorySlot && memorySlot !== kDisabledMemorySlot) {
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

  const entry = isPlainObject(cfg.plugins.entries[pluginId])
    ? cfg.plugins.entries[pluginId]
    : {};
  ensurePluginAllowed({ cfg, pluginId });
  cfg.plugins.entries[pluginId] = {
    ...entry,
    enabled: true,
  };
  writeMemorySlot({ fsModule, openclawDir, cfg, memorySlot: pluginId });
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
    memorySlot: pluginId,
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
      });
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
  isWorkspaceBootstrapComplete,
  kDisabledMemorySlot,
  kManagedActiveMemoryPluginId,
  kManagedTeamyouMemoryPluginId,
};
