const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { registerBrowseRoutes } = require("../routes/browse");
const { registerAccountLoginRoutes } = require("../routes/account-logins");
const {
  buildDoctorStatus,
  buildStatus,
  buildUsageSummary,
  buildWatchdogStatus,
  clone,
  createState,
  kModels,
  kModelAccessModes,
} = require("./fixtures");
const { prepareSandboxWorkspace } = require("./workspace");

const kValidScenarios = new Set(["healthy", "attention", "empty", "setup"]);

const parseBool = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
};

const getScenarioFromRequest = (req) => {
  const scenario = String(req.query?.scenario || "").trim();
  return kValidScenarios.has(scenario) ? scenario : "";
};

const sendSetupHtml = (res) =>
  res.sendFile(path.join(__dirname, "..", "..", "public", "setup.html"));

const createLocalShellCmd = () => (cmd, opts = {}) =>
  new Promise((resolve, reject) => {
    const { timeout, timeoutMs, ...execOpts } = opts;
    exec(
      cmd,
      {
        ...execOpts,
        timeout: timeout ?? timeoutMs ?? 60000,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "").trim();
          err.stderr = String(stderr || "").trim();
          return reject(err);
        }
        resolve(String(stdout || "").trim());
      },
    );
  });

const createSandboxClaudeCliAuthProfiles = (state) => ({
  hasClaudeCliProfile: () => !!state.claudeCliConfigured,
  upsertClaudeCliProfile: () => {
    state.claudeCliConfigured = true;
  },
});

const getAgentRuntimeId = (value) => {
  const runtime = value?.agentRuntime;
  if (typeof runtime === "string") return runtime.trim();
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    return String(runtime.id || "").trim();
  }
  return "";
};

const buildModelRuntimeIds = (configuredModels = {}) =>
  Object.fromEntries(
    Object.entries(configuredModels || {})
      .map(([modelKey, value]) => [modelKey, getAgentRuntimeId(value)])
      .filter(([, runtimeId]) => runtimeId),
  );

const createSandboxRoutes = ({
  app,
  state,
  port,
  realClaudeCli = false,
  realClaudeCliHomeDir = "",
  realClaudeCliShellCmd,
  realClaudeCliSpawnFn,
}) => {
  const setScenario = (scenario) => {
    if (!scenario || scenario === state.scenario) return;
    const next = createState({
      mode: scenario === "setup" ? "setup" : "dashboard",
      scenario,
      port,
    });
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, next);
  };

  app.use((req, _res, next) => {
    setScenario(getScenarioFromRequest(req));
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", gateway: "sandbox" });
  });

  app.get(["/", "/setup"], (req, res) => {
    setScenario(getScenarioFromRequest(req));
    sendSetupHtml(res);
  });

  app.get("/api/auth/status", (_req, res) => {
    res.json({ authEnabled: false, uiSandbox: true });
  });
  app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/logout", (_req, res) => res.json({ ok: true }));

  app.get("/api/onboard/status", (_req, res) => {
    res.json({
      onboarded: !!state.onboarded,
      setupUrl: `http://localhost:${port}/#/general`,
      publicBaseUrl: `http://localhost:${port}`,
      tailscaleDns: "alphaclaw-sandbox.tailnet.local",
    });
  });
  app.post("/api/onboard", (_req, res) => {
    state.onboarded = true;
    state.mode = "dashboard";
    if (state.scenario === "setup") state.scenario = "healthy";
    res.json({
      ok: true,
      setupUrl: `http://localhost:${port}/#/general`,
      publicBaseUrl: `http://localhost:${port}`,
      tailscaleDns: "alphaclaw-sandbox.tailnet.local",
      sandbox: true,
    });
  });
  app.post("/api/onboard/github/verify", (_req, res) => {
    res.status(410).json({
      ok: false,
      error: "GitHub import is not available in the AlphaClaw UI sandbox.",
    });
  });
  app.post("/api/onboard/import/scan", (_req, res) => {
    res.status(410).json({ ok: false, error: "Import is unavailable in sandbox mode" });
  });
  app.post("/api/onboard/import/apply", (_req, res) => {
    res.status(410).json({ ok: false, error: "Import is unavailable in sandbox mode" });
  });

  app.get("/api/status", (_req, res) => res.json(buildStatus(state)));
  app.get("/api/tailscale/status", (_req, res) => {
    res.json({
      ok: true,
      capability: {
        ok: true,
        available: true,
        compatible: true,
        requestVersion: 2,
      },
      current: {
        currentDns: "alphaclaw.sandbox-old.ts.net",
        setupUrl: `http://localhost:${port}/#/general`,
        publicBaseUrl: `http://localhost:${port}`,
      },
      change: { version: 1, state: "idle", warnings: [] },
    });
  });
  app.post("/api/tailscale/change/validate", (req, res) => {
    if (!String(req.body?.tailscaleApiToken || "").trim()) {
      res.status(400).json({ ok: false, error: "Token is required" });
      return;
    }
    res.json({
      ok: true,
      currentDns: "alphaclaw.sandbox-old.ts.net",
      currentSetupUrl: `http://localhost:${port}/#/general`,
      policyChanged: true,
      httpsAlreadyEnabled: false,
      warnings: [
        "Webhook and OAuth callback URLs that use the current public address must be updated after the change.",
        "You will need to sign in to AlphaClaw again at the new address.",
      ],
    });
  });
  app.post("/api/tailscale/change", (_req, res) => {
    res.status(202).json({
      ok: true,
      operationId: "sandbox-tailnet-change",
      state: "queued",
      reconnectAfterMs: 5000,
    });
  });
  app.get("/api/events/status", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    const writeEvent = () => {
      res.write("event: status\n");
      res.write(
        `data: ${JSON.stringify({
          status: buildStatus(state),
          watchdogStatus: buildWatchdogStatus(state),
          doctorStatus: buildDoctorStatus(state),
          timestamp: new Date().toISOString(),
        })}\n\n`,
      );
    };
    writeEvent();
    const intervalId = setInterval(writeEvent, 2000);
    req.on("close", () => clearInterval(intervalId));
  });

  app.get("/api/models", (_req, res) => {
    res.json({
      ok: true,
      models: clone(kModels),
      source: "sandbox",
      fetchedAt: Date.now(),
      refreshing: false,
      stale: false,
      accessModes: clone(kModelAccessModes),
    });
  });
  app.get("/api/models/status", (_req, res) => {
    res.json({ ok: true, source: "sandbox", refreshing: false });
  });
  app.get("/api/models/thinking-options", (_req, res) => {
    res.json({ ok: true, supported: true, options: ["auto", "low", "medium", "high"] });
  });
  app.post("/api/models/set", (req, res) => {
    state.primaryModel = String(req.body?.modelKey || req.body?.key || "");
    res.json({ ok: true, primary: state.primaryModel });
  });
  app.get("/api/models/config", (_req, res) => {
    const configuredModels = state.modelsConfig?.configuredModels || {};
    const primary =
      state.primaryModel ||
      state.modelsConfig?.primary ||
      Object.keys(configuredModels)[0] ||
      "";
    res.json({
      ok: true,
      primary,
      configuredModels,
      modelRuntimeIds: buildModelRuntimeIds(configuredModels),
      authProfiles: [
        {
          id: "anthropic-default",
          provider: "anthropic",
          type: "api-key",
          label: "Sandbox Anthropic",
          key: "sk-ant-sandbox",
        },
        {
          id: "anthropic:claude-cli",
          provider: "claude-cli",
          type: "oauth",
          label: "Sandbox Claude CLI",
        },
      ],
      authOrder: {
        anthropic: ["anthropic-default", "anthropic:claude-cli"],
      },
    });
  });
  app.put("/api/models/config", (req, res) => {
    state.primaryModel = String(req.body?.primary || state.primaryModel || "");
    if (req.body?.configuredModels && typeof req.body.configuredModels === "object") {
      state.modelsConfig = {
        ...(state.modelsConfig || {}),
        primary: state.primaryModel,
        configuredModels: clone(req.body.configuredModels),
      };
    }
    res.json({ ok: true, changed: true, restartRequired: false });
  });
  app.get("/api/models/auth", (_req, res) => {
    res.json({ ok: true, profiles: [], order: {} });
  });
  app.put("/api/models/auth/:profileId", (req, res) => {
    res.json({ ok: true, profileId: req.params.profileId, credential: req.body || {} });
  });
  app.delete("/api/models/auth/:profileId", (req, res) => {
    res.json({ ok: true, removed: req.params.profileId });
  });
  app.get("/api/codex/status", (_req, res) => {
    res.json({ connected: true, accountId: "sandbox-codex" });
  });
  app.post("/api/codex/exchange", (_req, res) => {
    res.json({ ok: true, connected: true });
  });
  app.post("/api/codex/disconnect", (_req, res) => {
    res.json({ ok: true, changed: true });
  });
  if (realClaudeCli) {
    registerAccountLoginRoutes({
      app,
      shellCmd: realClaudeCliShellCmd || createLocalShellCmd(),
      gatewayEnv: () => ({
        ...process.env,
        ...(realClaudeCliHomeDir ? { HOME: realClaudeCliHomeDir } : {}),
      }),
      authProfiles: createSandboxClaudeCliAuthProfiles(state),
      ...(realClaudeCliSpawnFn ? { spawnFn: realClaudeCliSpawnFn } : {}),
    });
  } else {
    app.get("/api/account-logins/claude-cli/status", (_req, res) => {
      res.json({
        ok: true,
        installed: true,
        binary: "/usr/local/bin/claude",
        version: "2.1.170 (Claude Code sandbox)",
        loggedIn: !!state.claudeCliLoggedIn,
        email: state.claudeCliLoggedIn ? "sandbox@example.com" : "",
        loginMethod: state.claudeCliLoggedIn ? "Claude Max account" : "",
        statusText: state.claudeCliLoggedIn
          ? "Login method: Claude Max account\nEmail: sandbox@example.com"
          : "",
        configured: !!state.claudeCliConfigured,
        profileId: "anthropic:claude-cli",
      });
    });
    app.post("/api/account-logins/claude-cli/login/start", (_req, res) => {
      state.claudeCliLoginStarted = true;
      state.claudeCliLoggedIn = false;
      state.claudeCliLoginOutput =
        "Opening Claude login in sandbox...\nOpen https://claude.ai/login/device and paste code SANDBOX-CODE here.\n";
      res.json({ ok: true, id: "sandbox-claude-login" });
    });
    app.post("/api/account-logins/claude-cli/login/:id/input", (req, res) => {
      const input = String(req.body?.input || "").trim();
      if (!state.claudeCliLoginStarted) {
        res.status(404).json({ ok: false, error: "Claude login operation not found" });
        return;
      }
      if (!input) {
        res.status(400).json({ ok: false, error: "Claude login code is required" });
        return;
      }
      state.claudeCliLoggedIn = true;
      state.claudeCliLoginOutput =
        "Opening Claude login in sandbox...\nLogin method: Claude Max account\nEmail: sandbox@example.com\n";
      res.json({ ok: true });
    });
    app.get("/api/account-logins/claude-cli/login/:id/events", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      let timer = null;
      const writeCurrent = () => {
        const done = !!state.claudeCliLoggedIn;
        res.write(`event: ${done ? "done" : "phase"}\n`);
        res.write(
          `data: ${JSON.stringify({
            id: req.params.id,
            status: done ? "complete" : "running",
            output: state.claudeCliLoginOutput || "",
            exitCode: done ? 0 : null,
            error: "",
          })}\n\n`,
        );
        if (done) {
          if (timer) clearInterval(timer);
          res.end();
        }
      };
      writeCurrent();
      timer = setInterval(writeCurrent, 500);
      req.on("close", () => clearInterval(timer));
    });
    app.post("/api/account-logins/claude-cli/adopt", (_req, res) => {
      if (!state.claudeCliLoggedIn) {
        res.status(400).json({
          ok: false,
          error: "Run Claude CLI login before adopting Claude CLI reuse",
        });
        return;
      }
      state.claudeCliConfigured = true;
      res.json({
        ok: true,
        changed: true,
        status: {
          ok: true,
          installed: true,
          binary: "/usr/local/bin/claude",
          version: "2.1.170 (Claude Code sandbox)",
          loggedIn: true,
          email: "sandbox@example.com",
          loginMethod: "Claude Max account",
          statusText: "Login method: Claude Max account\nEmail: sandbox@example.com",
          configured: true,
          profileId: "anthropic:claude-cli",
        },
      });
    });
  }

  app.get("/api/env", (_req, res) => res.json({ ok: true, vars: clone(state.envVars) }));
  app.put("/api/env", (req, res) => {
    state.envVars = Array.isArray(req.body?.vars) ? clone(req.body.vars) : [];
    res.json({ ok: true, changed: true, restartRequired: false });
  });
  app.get("/api/sync-cron", (_req, res) => {
    res.json({ ok: true, enabled: false, schedule: "0 * * * *", installed: false, scriptExists: true });
  });
  app.put("/api/sync-cron", (_req, res) => {
    res.json({ ok: true, syncCron: { enabled: false, schedule: "0 * * * *", installed: false, scriptExists: true } });
  });
  app.post("/api/github-sync/config", (_req, res) => {
    res.json({ ok: true, repo: "sandbox/demo", syncCron: { enabled: false, installed: false } });
  });
  app.put("/api/alphaclaw/config/features/openai-compat-api", (req, res) => {
    state.openAiCompatApiEnabled = req.body?.enabled !== false;
    res.json({
      ok: true,
      changed: true,
      restartRequired: false,
      config: { features: { openAiCompatApi: { enabled: state.openAiCompatApiEnabled } } },
    });
  });
  app.get("/api/alphaclaw/config", (_req, res) => {
    res.json({ ok: true, config: { features: { openAiCompatApi: { enabled: state.openAiCompatApiEnabled } } } });
  });
  app.get("/api/alphaclaw/version", (_req, res) => {
    res.json({
      currentVersion: "0.9.18-sandbox",
      currentOpenclawVersion: "2026.6.10-sandbox",
      latestVersion: "0.9.18-sandbox",
      latestOpenclawVersion: "2026.6.10-sandbox",
      hasUpdate: false,
      updateStrategy: "local",
    });
  });
  app.get("/api/alphaclaw/release-notes", (_req, res) => {
    res.json({ ok: true, tag: "sandbox", name: "Sandbox", body: "Synthetic release notes.", htmlUrl: "" });
  });
  app.post("/api/alphaclaw/update", (_req, res) => {
    res.json({ ok: true, sandbox: true, message: "Sandbox update skipped" });
  });

  app.get("/api/watchdog/status", (_req, res) => res.json({ ok: true, status: buildWatchdogStatus(state) }));
  app.get("/api/watchdog/events", (_req, res) => {
    res.json({
      ok: true,
      events: [
        { id: 1, level: "info", message: "Sandbox health check passed", createdAt: new Date().toISOString() },
        ...(state.scenario === "attention"
          ? [{ id: 2, level: "warning", message: "Synthetic restart in progress", createdAt: new Date().toISOString() }]
          : []),
      ],
    });
  });
  app.get("/api/watchdog/logs", (_req, res) => {
    res.type("text/plain").send("[sandbox] watchdog log stream\n[sandbox] no real gateway process is running\n");
  });
  app.get("/api/watchdog/resources", (_req, res) => {
    res.json({
      ok: true,
      resources: {
        cpu: { usagePercent: state.scenario === "attention" ? 72 : 18 },
        memory: { usedBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 },
        disk: { usedBytes: 4 * 1024 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 * 1024 },
      },
    });
  });
  app.get("/api/watchdog/settings", (_req, res) => res.json({ ok: true, settings: clone(state.watchdogSettings) }));
  app.put("/api/watchdog/settings", (req, res) => {
    state.watchdogSettings = { ...state.watchdogSettings, ...(req.body || {}) };
    res.json({ ok: true, settings: clone(state.watchdogSettings) });
  });
  app.post("/api/watchdog/repair", (_req, res) => {
    state.restartRequired = false;
    res.json({ ok: true, result: { ok: true, sandbox: true } });
  });
  app.post("/api/watchdog/test-notification", (_req, res) => res.json({ ok: true, result: { sandbox: true } }));
  app.post("/api/watchdog/terminal/session", (_req, res) => res.json({ ok: true, session: { id: state.terminal.sessionId, cursor: 0 } }));
  app.get("/api/watchdog/terminal/output", (_req, res) => {
    res.json({ ok: true, found: true, output: state.terminal.output, cursor: state.terminal.output.length, ended: false });
  });
  app.post("/api/watchdog/terminal/input", (req, res) => {
    state.terminal.output += `$ ${String(req.body?.input || "").trim()}\n[sandbox] command accepted\n`;
    res.json({ ok: true });
  });
  app.post("/api/watchdog/terminal/close", (_req, res) => res.json({ ok: true }));

  app.get("/api/usage/summary", (_req, res) => res.json({ ok: true, summary: buildUsageSummary(), cached: false }));
  app.get("/api/usage/sessions", (_req, res) => res.json({ ok: true, sessions: clone(state.sessions) }));
  app.get("/api/usage/sessions/:id", (req, res) => {
    const detail = state.sessions.find((entry) => entry.sessionId === req.params.id || entry.sessionKey === req.params.id);
    if (!detail) return res.status(404).json({ ok: false, error: "Session not found" });
    return res.json({ ok: true, detail: { ...clone(detail), messages: [{ role: "user", content: "What changed?" }, { role: "assistant", content: "Synthetic summary ready." }] } });
  });
  app.get("/api/usage/sessions/:id/timeseries", (_req, res) => {
    res.json({ ok: true, series: Array.from({ length: 12 }, (_, idx) => ({ timestamp: Date.now() - idx * 60000, tokens: 1200 + idx * 100, cost: 0.02 + idx * 0.001 })) });
  });
  app.get("/api/agent/sessions", (_req, res) => res.json({ ok: true, sessions: clone(state.sessions) }));
  app.post("/api/agent/message", (_req, res) => res.json({ ok: true, stdout: "Sandbox message accepted." }));
  app.get("/api/chat/history", (req, res) => {
    res.json({ ok: true, sessionKey: req.query?.sessionKey || "", messages: [], rawHistory: [] });
  });

  app.get("/api/doctor/status", (_req, res) => res.json({ ok: true, status: buildDoctorStatus(state) }));
  app.post("/api/doctor/run", (_req, res) => res.status(202).json({ ok: true, runId: "doctor-run-1", sandbox: true }));
  app.get("/api/doctor/runs", (_req, res) => {
    res.json({ ok: true, runs: [{ id: "doctor-run-1", status: "complete", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }] });
  });
  app.get("/api/doctor/cards", (_req, res) => res.json({ ok: true, cards: clone(state.doctorCards) }));
  app.get("/api/doctor/runs/:id", (req, res) => {
    res.json({ ok: true, run: { id: req.params.id, status: "complete", summary: "Synthetic Doctor run" } });
  });
  app.get("/api/doctor/runs/:id/cards", (_req, res) => res.json({ ok: true, cards: clone(state.doctorCards) }));
  app.post("/api/doctor/cards/:id/status", (req, res) => {
    const card = state.doctorCards.find((entry) => entry.id === req.params.id);
    if (card) card.status = String(req.body?.status || card.status);
    res.json({ ok: true, card: clone(card || {}) });
  });
  app.post("/api/doctor/findings/:id/fix", (_req, res) => {
    res.json({ ok: true, sandbox: true, message: "Sandbox fix request accepted." });
  });

  app.get("/api/cron/jobs", (_req, res) => res.json({ ok: true, storePath: "sandbox", jobs: clone(state.cronJobs) }));
  app.get("/api/cron/status", (_req, res) => res.json({ ok: true, status: { running: true, jobs: state.cronJobs.length, sandbox: true } }));
  app.get("/api/cron/jobs/:id/runs", (req, res) => {
    res.json({ ok: true, runs: { entries: [{ id: `${req.params.id}-run-1`, jobId: req.params.id, status: "success", deliveryStatus: "delivered", startedAtMs: Date.now() - 3600000, completedAtMs: Date.now() - 3590000, output: "Sandbox run complete" }], total: 1, offset: 0, limit: 25, hasMore: false, nextOffset: 1 } });
  });
  app.post("/api/cron/jobs/:id/run", (req, res) => res.json({ ok: true, result: { id: `${req.params.id}-manual`, status: "queued", sandbox: true } }));
  app.post("/api/cron/jobs/:id/enable", (req, res) => {
    const job = state.cronJobs.find((entry) => entry.id === req.params.id);
    if (job) job.enabled = true;
    res.json({ ok: true, result: { enabled: true } });
  });
  app.post("/api/cron/jobs/:id/disable", (req, res) => {
    const job = state.cronJobs.find((entry) => entry.id === req.params.id);
    if (job) job.enabled = false;
    res.json({ ok: true, result: { enabled: false } });
  });
  app.put("/api/cron/jobs/:id/prompt", (req, res) => {
    const job = state.cronJobs.find((entry) => entry.id === req.params.id);
    if (job) job.prompt = { message: String(req.body?.message || "") };
    res.json({ ok: true, result: clone(job || {}) });
  });
  app.put("/api/cron/jobs/:id/routing", (req, res) => {
    const job = state.cronJobs.find((entry) => entry.id === req.params.id);
    if (job) {
      job.sessionTarget = String(req.body?.sessionTarget || "main");
      job.wakeMode = String(req.body?.wakeMode || "now");
      job.delivery = {
        mode: String(req.body?.deliveryMode || "none"),
        channel: String(req.body?.deliveryChannel || ""),
        to: String(req.body?.deliveryTo || ""),
      };
    }
    res.json({ ok: true, result: clone(job || {}) });
  });
  app.get("/api/cron/jobs/:id/usage", (_req, res) => res.json({ ok: true, usage: { runs: 12, success: 11, error: 1, tokens: 34000, cost: 0.44 } }));
  app.get("/api/cron/jobs/:id/trends", (_req, res) => res.json({ ok: true, trends: { buckets: Array.from({ length: 7 }, (_, idx) => ({ label: dayKey(6 - idx), success: idx + 1, error: idx === 5 ? 1 : 0 })) } }));
  app.get("/api/cron/usage/bulk", (_req, res) => res.json({ ok: true, usage: state.cronJobs.map((job) => ({ jobId: job.id, runs: 5, tokens: 12000, cost: 0.18 })) }));
  app.get("/api/cron/runs/bulk", (_req, res) => res.json({ ok: true, runs: state.cronJobs.map((job) => ({ jobId: job.id, entries: [{ id: `${job.id}-run`, status: "success", startedAtMs: Date.now() - 100000 }] })) }));

  app.get("/api/agents", (_req, res) => res.json({ ok: true, agents: clone(state.agents), defaults: { defaultAgentId: "main" } }));
  app.post("/api/agents", (req, res) => {
    const id = String(req.body?.id || req.body?.name || `agent-${state.agents.length + 1}`).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const agent = { id, name: req.body?.name || id, default: false, identity: req.body?.identity || {}, tools: {}, workspacePath: `workspace/${id}` };
    state.agents.push(agent);
    res.status(201).json({ ok: true, agent: clone(agent), restartRequired: false });
  });
  app.get("/api/agents/:id/workspace-size", (_req, res) => res.json({ ok: true, bytes: 184320, files: 14 }));
  app.get("/api/agents/:id/bindings", (_req, res) => res.json({ ok: true, bindings: [] }));
  app.post("/api/agents/:id/bindings", (_req, res) => res.json({ ok: true, binding: {} }));
  app.delete("/api/agents/:id/bindings", (_req, res) => res.json({ ok: true }));
  app.post("/api/agents/:id/default", (req, res) => {
    state.agents.forEach((agent) => { agent.default = agent.id === req.params.id; });
    res.json({ ok: true });
  });
  app.get("/api/agents/:id", (req, res) => {
    const agent = state.agents.find((entry) => entry.id === req.params.id);
    if (!agent) return res.status(404).json({ ok: false, error: "Agent not found" });
    return res.json({ ok: true, agent: clone(agent) });
  });
  app.put("/api/agents/:id", (req, res) => {
    const idx = state.agents.findIndex((entry) => entry.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Agent not found" });
    state.agents[idx] = { ...state.agents[idx], ...(req.body || {}) };
    return res.json({ ok: true, agent: clone(state.agents[idx]), restartRequired: false });
  });
  app.delete("/api/agents/:id", (req, res) => {
    state.agents = state.agents.filter((entry) => entry.id !== req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/channels/accounts", (_req, res) => {
    res.json({ ok: true, channels: { telegram: [{ provider: "telegram", accountId: "default", label: "Sandbox Telegram", agentId: "main" }] } });
  });
  app.get("/api/channels/accounts/token", (_req, res) => res.json({ ok: true, token: "sandbox-token", masked: true }));
  app.post("/api/channels/telegram/inspect-token", (_req, res) => res.json({
    ok: true,
    bot: {
      id: "123456789",
      name: "Alpha Wolf",
      username: "alpha_wolf_bot",
      link: "https://t.me/alpha_wolf_bot",
    },
  }));
  app.post("/api/channels/discord/inspect-token", (_req, res) => res.json({
    ok: true,
    bot: {
      id: "123456789012345678",
      applicationId: "123456789012345678",
      name: "Alpha Wolf",
      username: "alpha-wolf",
      avatarUrl: "",
      developerPortalUrl: "https://discord.com/developers/applications/123456789012345678/bot",
      installUrl: "https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=274878024768&integration_type=0&scope=bot+applications.commands",
      installPermissions: "274878024768",
      intents: { messageContent: true, guildMembers: true },
      guilds: [{ id: "234567890123456789", name: "AlphaClaw Test Server" }],
    },
  }));
  app.post("/api/channels/slack/inspect-credentials", (_req, res) => res.json({
    ok: true,
    slack: {
      appId: "A0123456789",
      appSettingsUrl: "https://api.slack.com/apps/A0123456789",
      workspace: {
        id: "T0123456789",
        name: "AlphaClaw Test Workspace",
        url: "https://alphaclaw-test.slack.com/",
      },
      bot: {
        id: "B0123456789",
        userId: "U0123456789",
        name: "Alpha Wolf",
      },
      scopes: { checked: true, granted: [], missing: [] },
    },
  }));
  app.post("/api/channels/accounts", (_req, res) => res.status(201).json({ ok: true, account: { accountId: "sandbox" }, restartRequired: false }));
  app.post("/api/channels/accounts/jobs", (_req, res) => res.status(202).json({ ok: true, operationId: "sandbox-operation", streamUrl: "/api/operations/sandbox-operation/events" }));
  app.get("/api/operations/:operationId/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`event: done\ndata: ${JSON.stringify({ ok: true, operationId: req.params.operationId })}\n\n`);
    res.end();
  });
  app.put("/api/channels/accounts", (_req, res) => res.json({ ok: true, restartRequired: false }));
  app.delete("/api/channels/accounts", (_req, res) => res.json({ ok: true }));
  app.post("/api/channels/accounts/login", (_req, res) => res.json({ ok: true, completed: true, stdout: "Sandbox login complete", stderr: "", code: 0 }));
  app.get("/api/channels/accounts/login-status", (_req, res) => res.json({ ok: true, connected: true }));

  app.get("/api/nodes", (_req, res) => {
    res.json({ ok: true, nodes: [{ id: "local-sandbox", nodeId: "local-sandbox", name: "Local sandbox", paired: true, status: "online" }], pending: [] });
  });
  app.post("/api/nodes/:id/approve", (_req, res) => res.json({ ok: true }));
  app.delete("/api/nodes/:id", (_req, res) => res.json({ ok: true, restartRequired: false }));
  app.post("/api/nodes/:id/route", (req, res) => res.json({ ok: true, restartRequired: false, nodeId: req.params.id }));
  app.get("/api/nodes/connect-info", (_req, res) => res.json({ ok: true, command: "alphaclaw nodes connect --sandbox", token: "sandbox-token" }));
  app.get("/api/nodes/:id/browser-status", (_req, res) => res.json({ ok: true, profile: "user", status: { running: true, url: "http://localhost:9222" } }));
  app.get("/api/nodes/exec-config", (_req, res) => res.json({ ok: true, config: { host: "gateway", security: "allowlist", ask: "on-miss", node: "" } }));
  app.put("/api/nodes/exec-config", (_req, res) => res.json({ ok: true, restartRequired: false }));
  app.get("/api/nodes/exec-approvals", (_req, res) => res.json({ ok: true, config: { version: 1, agents: { "*": { allowlist: [] } } } }));
  app.post("/api/nodes/exec-approvals/allowlist", (req, res) => res.json({ ok: true, entry: { id: "sandbox-rule", pattern: req.body?.pattern || "*" } }));
  app.delete("/api/nodes/exec-approvals/allowlist/:id", (_req, res) => res.json({ ok: true }));
  app.get("/api/devices", (_req, res) => res.json({ pending: [], cliAutoApproveComplete: true }));

  app.get("/api/google/accounts", (_req, res) => res.json({ ok: true, accounts: [{ id: "default", email: "sandbox@example.com", client: "default", authenticated: true, services: ["gmail"] }] }));
  app.post("/api/google/accounts", (req, res) => res.json({ ok: true, accountId: "default", account: { id: "default", email: req.body?.email || "sandbox@example.com" } }));
  app.get("/api/google/status", (_req, res) => res.json({ ok: true, accountId: "default", authenticated: true, email: "sandbox@example.com" }));
  app.get("/api/google/credentials", (_req, res) => res.json({ ok: true, configured: true, credentials: { clientId: "sandbox-client", email: "sandbox@example.com" } }));
  app.post("/api/google/credentials", (_req, res) => res.json({ ok: true, accountId: "default", account: { id: "default", email: "sandbox@example.com" } }));
  app.get("/api/google/check", (_req, res) => res.json({ accountId: "default", email: "sandbox@example.com", results: [] }));
  app.post("/api/google/disconnect", (_req, res) => res.json({ ok: true }));
  let sandboxGoogleProvider = "gog";
  const sandboxComposioStatus = () => ({
    ok: true,
    provider: sandboxGoogleProvider,
    providerSource: "state",
    cliInstalled: true,
    loggedIn: true,
    apiKeyConfigured: true,
    accounts: [
      { id: "ca_sandbox_gmail", toolkit: "gmail", status: "ACTIVE", active: true, label: "sandbox@example.com" },
      { id: "ca_sandbox_cal", toolkit: "googlecalendar", status: "ACTIVE", active: true, label: "sandbox@example.com" },
    ],
    googleAccounts: [
      { id: "ca_sandbox_gmail", toolkit: "gmail", status: "ACTIVE", active: true, label: "sandbox@example.com" },
      { id: "ca_sandbox_cal", toolkit: "googlecalendar", status: "ACTIVE", active: true, label: "sandbox@example.com" },
    ],
    googleToolkits: ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets", "googletasks", "googlemeet"],
    refreshedAt: 1752000000000,
    lastError: "",
  });
  app.get("/api/google/provider", (_req, res) => res.json({ ok: true, provider: sandboxGoogleProvider, source: "state", providers: ["gog", "composio", "none"] }));
  app.post("/api/google/provider", (req, res) => {
    const provider = String(req.body?.provider || "").trim();
    if (!["gog", "composio", "none"].includes(provider)) {
      return res.json({ ok: false, error: "Invalid provider. Expected one of: gog, composio, none" });
    }
    sandboxGoogleProvider = provider;
    res.json({ ok: true, provider, source: "state" });
  });
  app.get("/api/composio/status", (_req, res) => res.json(sandboxComposioStatus()));
  app.post("/api/composio/refresh", (_req, res) => res.json(sandboxComposioStatus()));
  app.get("/api/gmail/config", (_req, res) => res.json({ ok: true, config: { enabled: true, topicPath: "projects/sandbox/topics/gmail", projectId: "sandbox" } }));
  app.post("/api/gmail/config", (_req, res) => res.json({ ok: true, config: { enabled: true } }));
  app.post("/api/gmail/watch/start", (_req, res) => res.json({ ok: true, status: { active: true } }));
  app.post("/api/gmail/watch/stop", (_req, res) => res.json({ ok: true, status: { active: false } }));
  app.post("/api/gmail/watch/renew", (_req, res) => res.json({ ok: true, status: { active: true } }));

  app.get("/api/pairings", (_req, res) => res.json({ pending: [] }));
  app.post("/api/pairings/:id/approve", (_req, res) => res.json({ ok: true }));
  app.post("/api/pairings/:id/reject", (_req, res) => res.json({ ok: true }));

  app.get("/api/webhooks", (_req, res) => res.json({ ok: true, webhooks: clone(state.webhooks) }));
  app.post("/api/webhooks", (req, res) => {
    const name = String(req.body?.name || `sandbox-hook-${state.webhooks.length + 1}`).trim();
    const webhook = { name, path: `/hooks/${name}`, managed: false, destination: req.body?.destination || null, lastReceived: null, totalCount: 0, successCount: 0, errorCount: 0, health: "green", oauthCallbackEnabled: !!req.body?.oauthCallback };
    state.webhooks.push(webhook);
    res.status(201).json({ ok: true, webhook: clone(webhook), restartRequired: false });
  });
  app.get("/api/webhooks/:name/requests/:id", (req, res) => {
    const request = state.webhookRequests.find((entry) => String(entry.id) === String(req.params.id));
    if (!request) return res.status(404).json({ ok: false, error: "Request not found" });
    return res.json({ ok: true, request: clone(request) });
  });
  app.get("/api/webhooks/:name/requests", (req, res) => {
    const requests = state.webhookRequests.filter((entry) => entry.hookName === req.params.name);
    res.json({ ok: true, requests: { entries: clone(requests), total: requests.length, offset: 0, limit: requests.length, hasMore: false } });
  });
  app.get("/api/webhooks/:name", (req, res) => {
    const webhook = state.webhooks.find((entry) => entry.name === req.params.name);
    if (!webhook) return res.status(404).json({ ok: false, error: "Webhook not found" });
    return res.json({
      ok: true,
      webhook: {
        ...clone(webhook),
        fullUrl: `http://localhost:${port}/hooks/${webhook.name}`,
        queryStringUrl: `http://localhost:${port}/hooks/${webhook.name}?token=<WEBHOOK_TOKEN>`,
        authHeaderValue: "Authorization: Bearer <WEBHOOK_TOKEN>",
        hasRuntimeToken: false,
        authNote: "Sandbox webhook URLs are synthetic.",
        transformPath: `webhooks/${webhook.name}/transform.js`,
      },
    });
  });
  app.put("/api/webhooks/:name/destination", (req, res) => {
    const webhook = state.webhooks.find((entry) => entry.name === req.params.name);
    if (webhook) webhook.destination = req.body?.destination || null;
    res.json({ ok: true, webhook: clone(webhook || {}), restartRequired: false });
  });
  app.post("/api/webhooks/:name/oauth-callback", (req, res) => res.status(201).json({ ok: true, callback: { callbackId: `${req.params.name}-oauth` } }));
  app.post("/api/webhooks/:name/oauth-callback/rotate", (req, res) => res.json({ ok: true, callback: { callbackId: `${req.params.name}-oauth-rotated` } }));
  app.delete("/api/webhooks/:name/oauth-callback", (_req, res) => res.json({ ok: true, deleted: true }));
  app.delete("/api/webhooks/:name", (req, res) => {
    state.webhooks = state.webhooks.filter((entry) => entry.name !== req.params.name);
    res.json({ ok: true, deleted: true, restartRequired: false });
  });

  app.post("/api/gateway/restart", (_req, res) => {
    state.restartRequired = false;
    res.json({ ok: true, restartRequired: false, sandbox: true });
  });
  app.get("/api/restart-status", (_req, res) => {
    res.json({ ok: true, restartRequired: !!state.restartRequired, restartInProgress: false });
  });
  app.post("/api/restart-status/dismiss", (_req, res) => {
    state.restartRequired = false;
    res.json({ ok: true });
  });
  app.get("/api/gateway/dashboard", (_req, res) => {
    res.json({ ok: true, url: "/openclaw", needsAuth: false, sandbox: true });
  });

  app.all("/api/*", (req, res) => {
    res.json({ ok: true, sandbox: true, path: req.path });
  });
};

const createUiSandboxServer = ({
  mode = "dashboard",
  scenario = "healthy",
  port = 3001,
  persist = false,
  workspaceRoot = "",
  realClaudeCli = false,
  realClaudeCliHome = "",
  realClaudeCliShellCmd,
  realClaudeCliSpawnFn,
} = {}) => {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  const state = createState({
    mode,
    scenario: mode === "setup" ? "setup" : scenario,
    port,
  });
  const { workspaceDir } = prepareSandboxWorkspace({
    persist,
    rootDir: workspaceRoot,
  });
  const realClaudeCliHomeDir =
    String(realClaudeCliHome || "").trim().toLowerCase() === "sandbox"
      ? path.join(workspaceDir, ".claude-home")
      : String(realClaudeCliHome || "").trim();
  if (realClaudeCliHomeDir) {
    fs.mkdirSync(realClaudeCliHomeDir, { recursive: true });
  }

  registerBrowseRoutes({ app, fs, kRootDir: workspaceDir });
  createSandboxRoutes({
    app,
    state,
    port,
    realClaudeCli,
    realClaudeCliHomeDir,
    realClaudeCliShellCmd,
    realClaudeCliSpawnFn,
  });
  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  const server = http.createServer(app);
  return { app, server, state, workspaceDir, realClaudeCliHomeDir };
};

const startUiSandboxServer = (options = {}) => {
  const { server, state, workspaceDir, realClaudeCliHomeDir } =
    createUiSandboxServer(options);
  const port = Number(options.port || 3001);
  server.listen(port, "0.0.0.0", () => {
    console.log(`[alphaclaw:sandbox] UI sandbox listening on http://localhost:${port}`);
    console.log(`[alphaclaw:sandbox] mode=${state.mode} scenario=${state.scenario}`);
    console.log(
      `[alphaclaw:sandbox] claude-cli=${options.realClaudeCli ? "real-local" : "mock"}`,
    );
    if (realClaudeCliHomeDir) {
      console.log(`[alphaclaw:sandbox] claude-cli-home=${realClaudeCliHomeDir}`);
    }
    console.log(`[alphaclaw:sandbox] workspace=${workspaceDir}`);
  });
  return { server, state, workspaceDir };
};

module.exports = {
  createUiSandboxServer,
  startUiSandboxServer,
};
