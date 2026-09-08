const crypto = require("crypto");
const path = require("path");
const {
  patchSeededBootstrapConnectStep,
} = require("./onboarding/workspace");
const { isWorkspaceBootstrapComplete } = require("./teamyou-memory-activation");
const { readOpenclawConfig } = require("./openclaw-config");
const { kClawbridgeSystemNotePrefix } = require("./chat-ws");
const {
  resolveDefaultAgentId,
  buildAgentMainSessionKey,
} = require("./default-agent");

// Sent as the agent's very first inbound message so the BOOTSTRAP.md ritual
// runs before the user ever types anything. The kClawbridgeSystemNotePrefix
// marker makes the chat history normalizer hide it from the rendered
// transcript; the agent still receives it.
const kBootstrapKickoffMessage =
  `${kClawbridgeSystemNotePrefix} Workspace setup just finished and the user ` +
  "is about to open this chat for the first time. This is your first run: " +
  "follow your first-run instructions (BOOTSTRAP.md) now and introduce " +
  "yourself.";

// Keep the initial handoff recoverable without requiring a Clawbridge service
// restart. Vault and gateway repair can legitimately outlive a fixed retry
// window, while each attempt remains a cheap, serialized readiness check.
const kDefaultMaxAttempts = Number.POSITIVE_INFINITY;
const kDefaultAttemptDelayMs = 10000;

// The kickoff must only ever fire once per install; the marker persists the
// decision (sent, or intentionally skipped) across restarts.
const kKickoffSentReason = "kickoff_sent";
const kAlreadyCompleteReason = "bootstrap_already_complete";
const kExistingSessionsReason = "existing_sessions";
const kBootstrapDisabledReason = "bootstrap_disabled";
const kBootstrapKickoffDecisionReasons = new Set([
  kKickoffSentReason,
  kAlreadyCompleteReason,
  kExistingSessionsReason,
  kBootstrapDisabledReason,
]);

const expandWorkspaceEnvReferences = (value, env) =>
  String(value || "").replace(
    /\$\$\{([A-Z_][A-Z0-9_]*)\}|\$\{([A-Z_][A-Z0-9_]*)\}/g,
    (match, escapedName, substitutionName) => {
      if (escapedName) return `\${${escapedName}}`;
      const replacement = env?.[substitutionName];
      return replacement === undefined || replacement === ""
        ? match
        : String(replacement);
    },
  );

const buildEffectiveWorkspaceEnv = ({ config, env }) => {
  const effectiveEnv = { ...(env || {}) };
  const configEnv = config?.env;
  if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) {
    return effectiveEnv;
  }
  const configEntries = {
    ...(configEnv.vars &&
    typeof configEnv.vars === "object" &&
    !Array.isArray(configEnv.vars)
      ? configEnv.vars
      : {}),
    ...Object.fromEntries(
      Object.entries(configEnv).filter(
        ([key]) => key !== "vars" && key !== "shellEnv",
      ),
    ),
  };
  for (const [key, value] of Object.entries(configEntries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    if (String(effectiveEnv[key] || "").trim()) continue;
    // OpenClaw does not inject config env values that themselves contain an
    // unresolved reference.
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) continue;
    effectiveEnv[key] = value;
  }
  return effectiveEnv;
};

const resolveDefaultAgentWorkspace = ({ config, agentId, fallback, env }) => {
  const configuredAgents = Array.isArray(config?.agents?.list)
    ? config.agents.list
    : [];
  const configuredAgent = configuredAgents.find(
    (entry) => String(entry?.id || "").trim() === agentId,
  );
  const effectiveEnv = buildEffectiveWorkspaceEnv({ config, env });
  const configured = expandWorkspaceEnvReferences(
    configuredAgent?.workspace || config?.agents?.defaults?.workspace || fallback,
    effectiveEnv,
  ).trim();
  if (!configured.startsWith("~")) return path.resolve(configured);
  // OpenClaw expands `~` from OPENCLAW_HOME. That may intentionally differ
  // from the service account's Unix HOME, which external CLIs still use.
  const home = String(
    effectiveEnv.OPENCLAW_HOME || effectiveEnv.HOME || "",
  ).trim();
  if (!home || (configured !== "~" && !configured.startsWith("~/"))) {
    return path.resolve(configured);
  }
  return configured === "~"
    ? path.resolve(home)
    : path.resolve(home, configured.slice(2));
};

const isBootstrapGenerationDisabled = ({ config, agentId }) => {
  const configuredAgents = Array.isArray(config?.agents?.list)
    ? config.agents.list
    : [];
  const configuredAgent = configuredAgents.find(
    (entry) => String(entry?.id || "").trim() === agentId,
  );
  return (
    configuredAgent?.skipBootstrap === true ||
    config?.agents?.defaults?.skipBootstrap === true
  );
};

const hasBootstrapKickoffDecision = ({ fs, markerPath }) => {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return (
      marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      kBootstrapKickoffDecisionReasons.has(String(marker.reason || ""))
    );
  } catch {
    return false;
  }
};

const countAgentSessionsFromListResult = (result) => {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(result?.sessions)
      ? result.sessions
      : Array.isArray(result?.rows)
        ? result.rows
        : [];
  return rows.filter((row) => {
    const key = String(row?.key || row?.sessionKey || "").trim();
    return key.startsWith("agent:");
  }).length;
};

const createBootstrapKickoffService = ({
  fs,
  constants,
  requestGateway,
  isRuntimeReady = async () => false,
  logger = console,
  maxAttempts = kDefaultMaxAttempts,
  attemptDelayMs = kDefaultAttemptDelayMs,
  env = process.env,
  getProcessStartedAtMs = () => Date.now() - process.uptime() * 1000,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  let inFlight = null;
  let loggedFinalizationDeferral = false;

  const readOnboardingMarker = () => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(constants.kOnboardingMarkerPath, "utf8"),
      );
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  // Managed hosts schedule a full service restart (host finalization) right
  // after onboarding completes; a kickoff run interrupted by it makes
  // OpenClaw inject a visible crash-recovery prompt into the transcript.
  // The restart is a known, recorded event, so the gate is event-based: the
  // process that completed onboarding (started before markedAt) must not
  // kick off — the restart replaces it, and the successor process (started
  // after markedAt) fires as soon as the gateway is reachable. If scheduling
  // the restart fails, onboarding flips hostFinalizationScheduled to false
  // in the marker and the polling loop below picks that up.
  const isAwaitingHostFinalizationRestart = (marker) => {
    if (marker.hostFinalizationScheduled !== true) return false;
    const markedAtMs = Date.parse(String(marker.markedAt || ""));
    if (!Number.isFinite(markedAtMs)) return false;
    return getProcessStartedAtMs() < markedAtMs;
  };

  const writeKickoffMarker = (details) => {
    fs.mkdirSync(path.dirname(constants.kBootstrapKickoffMarkerPath), {
      recursive: true,
    });
    const temporaryPath =
      `${constants.kBootstrapKickoffMarkerPath}.${process.pid}.` +
      `${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        { ...details, markedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
    );
    fs.renameSync(temporaryPath, constants.kBootstrapKickoffMarkerPath);
  };

  const attemptKickoff = async ({ config, agentId, workspaceDir }) => {
    // Someone already chatting means the ritual does not need a nudge.
    let existingAgentSessions = 0;
    try {
      const listResult = await requestGateway("sessions.list", {});
      existingAgentSessions = countAgentSessionsFromListResult(listResult);
    } catch (error) {
      logger.error(
        `[alphaclaw] Bootstrap kickoff session check failed (continuing): ${error.message}`,
      );
    }
    if (existingAgentSessions > 0) {
      writeKickoffMarker({
        kickedOff: false,
        reason: kExistingSessionsReason,
        existingAgentSessions,
      });
      return { ok: false, reason: kExistingSessionsReason };
    }

    const sessionKey = buildAgentMainSessionKey(agentId);
    // The gateway is up (sessions.list answered), so openclaw has seeded the
    // workspace — the last moment to rewrite BOOTSTRAP.md's optional Connect
    // step into the required Clawbridge version before the ritual reads it.
    patchSeededBootstrapConnectStep({
      fs,
      workspaceDir,
    });
    const result = await requestGateway("chat.send", {
      sessionKey,
      message: kBootstrapKickoffMessage,
      idempotencyKey: crypto.randomUUID(),
    });
    const runId = String(result?.runId || "").trim();
    writeKickoffMarker({
      kickedOff: true,
      reason: kKickoffSentReason,
      sessionKey,
      agentId,
      ...(runId ? { runId } : {}),
    });
    logger.log(
      `[alphaclaw] Bootstrap kickoff sent to ${sessionKey}${runId ? ` (run ${runId})` : ""}`,
    );
    return { ok: true, reason: kKickoffSentReason, sessionKey, runId };
  };

  const runKickoffFlow = async () => {
    if (!fs.existsSync(constants.kOnboardingMarkerPath)) {
      return { ok: false, reason: "not_onboarded" };
    }
    if (
      fs.existsSync(constants.kBootstrapKickoffMarkerPath) &&
      hasBootstrapKickoffDecision({
        fs,
        markerPath: constants.kBootstrapKickoffMarkerPath,
      })
    ) {
      return { ok: false, reason: "already_decided" };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Re-read each attempt: onboarding flips hostFinalizationScheduled to
      // false if scheduling the restart failed after the marker was written.
      if (isAwaitingHostFinalizationRestart(readOnboardingMarker())) {
        if (!loggedFinalizationDeferral) {
          loggedFinalizationDeferral = true;
          logger.log(
            "[alphaclaw] Bootstrap kickoff deferred: host finalization restart pending; the next boot sends the greeting",
          );
        }
        if (attempt < maxAttempts) await delay(attemptDelayMs);
        continue;
      }
      try {
        const config = readOpenclawConfig({
          fsModule: fs,
          openclawDir: constants.OPENCLAW_DIR,
          fallback: {},
        });
        const agentId = resolveDefaultAgentId(config);
        const workspaceDir = resolveDefaultAgentWorkspace({
          config,
          agentId,
          fallback: constants.WORKSPACE_DIR,
          env,
        });
        if (isBootstrapGenerationDisabled({ config, agentId })) {
          writeKickoffMarker({
            kickedOff: false,
            reason: kBootstrapDisabledReason,
          });
          return { ok: false, reason: kBootstrapDisabledReason };
        }
        const bootstrapState = isWorkspaceBootstrapComplete({
          fsModule: fs,
          workspaceDir,
        });
        if (bootstrapState.complete) {
          writeKickoffMarker({
            kickedOff: false,
            reason: kAlreadyCompleteReason,
            bootstrapReason: bootstrapState.reason,
          });
          return { ok: false, reason: kAlreadyCompleteReason };
        }
        // The first agent turn seeds an empty custom workspace. It must obey
        // the same runtime gate as dashboard entry, but it cannot wait for a
        // BOOTSTRAP.md file that OpenClaw creates as part of that turn.
        if (await isRuntimeReady()) {
          return await attemptKickoff({
            config,
            agentId,
            workspaceDir,
          });
        }
      } catch (error) {
        logger.error(
          `[alphaclaw] Bootstrap kickoff attempt ${attempt}/${maxAttempts} failed: ${error.message}`,
        );
      }
      // Workspace not seeded yet, or the gateway is still coming up:
      // wait and re-check.
      if (attempt < maxAttempts) await delay(attemptDelayMs);
    }
    // No marker on purpose: the next onboarded boot retries.
    logger.error("[alphaclaw] Bootstrap kickoff gave up; will retry on next boot");
    return { ok: false, reason: "gave_up" };
  };

  const maybeRunBootstrapKickoff = () => {
    if (!inFlight) {
      inFlight = runKickoffFlow()
        .catch((error) => {
          logger.error(`[alphaclaw] Bootstrap kickoff error: ${error.message}`);
          return { ok: false, reason: "error" };
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return { maybeRunBootstrapKickoff };
};

module.exports = {
  createBootstrapKickoffService,
  hasBootstrapKickoffDecision,
  kBootstrapKickoffMessage,
};
