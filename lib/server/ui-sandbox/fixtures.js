const kBootstrapModelCatalog = require("../model-catalog-bootstrap.json");

const kNow = Date.parse("2026-06-22T12:00:00Z");

const iso = (offsetMs = 0) => new Date(kNow + offsetMs).toISOString();
const dayKey = (daysAgo = 0) =>
  new Date(kNow - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const clone = (value) => JSON.parse(JSON.stringify(value));

const kModels = Array.isArray(kBootstrapModelCatalog.models)
  ? clone(kBootstrapModelCatalog.models)
  : [
      { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
      { key: "anthropic/claude-sonnet-4-6", label: "Sonnet 4.6" },
      { key: "openai/gpt-5.5", label: "GPT-5.5" },
      { key: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { key: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    ];

const createEnvVars = () => [
  {
    key: "ANTHROPIC_API_KEY",
    value: "sk-ant-sandbox",
    group: "ai",
    label: "Anthropic API Key",
  },
  {
    key: "OPENAI_API_KEY",
    value: "",
    group: "ai",
    label: "OpenAI API Key",
  },
  {
    key: "ALPHACLAW_SETUP_URL",
    value: "http://localhost:3001",
    group: "networking",
    label: "Setup URL",
  },
  {
    key: "ALPHACLAW_PUBLIC_BASE_URL",
    value: "http://localhost:3001",
    group: "networking",
    label: "Public callback URL",
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    value: "123456:sandbox",
    group: "channels",
    label: "Telegram Bot Token",
  },
];

const createAgents = () => [
  {
    id: "main",
    name: "Main Agent",
    default: true,
    identity: {
      name: "Operations Lead",
      emoji: "*",
      avatar: "",
      theme: "calm",
    },
    model: "anthropic/claude-opus-4-8",
    tools: { profile: "balanced", allow: ["workspace:read", "workspace:write"] },
    workspacePath: "workspace",
  },
  {
    id: "research",
    name: "Research",
    default: false,
    identity: {
      name: "Research Analyst",
      emoji: "+",
      avatar: "",
      theme: "curious",
    },
    model: "anthropic/claude-sonnet-4-6",
    tools: { profile: "read-mostly", allow: ["workspace:read"] },
    workspacePath: "workspace/research",
  },
];

const createSessions = () => [
  {
    sessionId: "session-main-001",
    sessionKey: "agent:main:telegram:direct:sandbox",
    agentId: "main",
    agentLabel: "Main Agent",
    updatedAt: kNow - 7 * 60 * 1000,
    lastActiveAt: kNow - 7 * 60 * 1000,
    title: "Daily operations check",
    messageCount: 18,
    totalTokens: 84200,
    totalCost: 1.74,
  },
  {
    sessionId: "session-research-001",
    sessionKey: "agent:research:hook:market-watch",
    agentId: "research",
    agentLabel: "Research",
    updatedAt: kNow - 64 * 60 * 1000,
    lastActiveAt: kNow - 64 * 60 * 1000,
    title: "Market watch summary",
    messageCount: 9,
    totalTokens: 42300,
    totalCost: 0.62,
  },
];

const createWebhooks = (scenario) => [
  {
    name: "deploy-events",
    path: "/hooks/deploy-events",
    managed: false,
    destination: { sessionKey: "agent:main:telegram:direct:sandbox" },
    lastReceived: iso(-22 * 60 * 1000),
    totalCount: 42,
    successCount: scenario === "attention" ? 38 : 42,
    errorCount: scenario === "attention" ? 4 : 0,
    recentTotalCount: 10,
    recentSuccessCount: scenario === "attention" ? 7 : 10,
    recentErrorCount: scenario === "attention" ? 3 : 0,
    healthWindowSize: 10,
    health: scenario === "attention" ? "yellow" : "green",
    oauthCallbackEnabled: false,
  },
  {
    name: "gmail-oauth",
    path: "/hooks/gmail-oauth",
    managed: true,
    destination: { sessionKey: "agent:main:telegram:direct:sandbox" },
    lastReceived: iso(-2 * 60 * 60 * 1000),
    totalCount: 11,
    successCount: 11,
    errorCount: 0,
    recentTotalCount: 4,
    recentSuccessCount: 4,
    recentErrorCount: 0,
    healthWindowSize: 10,
    health: "green",
    oauthCallbackEnabled: true,
  },
];

const createWebhookRequests = (scenario) => [
  {
    id: 1002,
    hookName: "deploy-events",
    status: scenario === "attention" ? "error" : "success",
    receivedAt: iso(-22 * 60 * 1000),
    payload: { action: "deploy", service: "web", environment: "preview" },
    response: scenario === "attention" ? "Transform failed" : "Queued",
    error: scenario === "attention" ? "Missing environment field" : "",
  },
  {
    id: 1001,
    hookName: "deploy-events",
    status: "success",
    receivedAt: iso(-3 * 60 * 60 * 1000),
    payload: { action: "deploy", service: "worker", environment: "prod" },
    response: "Queued",
    error: "",
  },
];

const createCronJobs = () => [
  {
    id: "daily-brief",
    name: "Daily brief",
    enabled: true,
    schedule: "0 8 * * *",
    nextRunAtMs: kNow + 20 * 60 * 60 * 1000,
    lastRunAtMs: kNow - 4 * 60 * 60 * 1000,
    sessionTarget: "main",
    wakeMode: "now",
    delivery: { mode: "channel", channel: "telegram", to: "sandbox" },
    prompt: { message: "Summarize overnight operational changes." },
  },
  {
    id: "weekly-cleanup",
    name: "Weekly cleanup",
    enabled: false,
    schedule: "0 9 * * 1",
    nextRunAtMs: kNow + 3 * 24 * 60 * 60 * 1000,
    lastRunAtMs: kNow - 4 * 24 * 60 * 60 * 1000,
    sessionTarget: "research",
    wakeMode: "next",
    delivery: { mode: "none", channel: "", to: "" },
    prompt: { message: "Find stale docs and config drift." },
  },
];

const createDoctorCards = (scenario) =>
  scenario === "attention"
    ? [
        {
          id: "doc-card-1",
          runId: "doctor-run-1",
          status: "open",
          severity: "warning",
          title: "Webhook failures increased",
          summary: "Recent deploy-events requests have failed validation.",
          path: "webhooks/deploy-events/transform.js",
          recommendation: "Check payload parsing before the next release.",
          createdAt: iso(-40 * 60 * 1000),
        },
      ]
    : [
        {
          id: "doc-card-healthy",
          runId: "doctor-run-1",
          status: "fixed",
          severity: "info",
          title: "Workspace baseline captured",
          summary: "No blocking findings in the current sandbox scenario.",
          path: "openclaw.json",
          recommendation: "Keep testing UI flows.",
          createdAt: iso(-2 * 60 * 60 * 1000),
        },
      ];

const createUsageSummary = () => {
  const daily = Array.from({ length: 30 }, (_, idx) => {
    const daysAgo = 29 - idx;
    const totalTokens = 12000 + idx * 1800;
    const totalCost = Number((0.12 + idx * 0.018).toFixed(4));
    return {
      date: dayKey(daysAgo),
      totalTokens,
      totalCost,
      models: [
        {
          model: "anthropic/claude-opus-4-8",
          totalTokens: Math.round(totalTokens * 0.7),
          totalCost: Number((totalCost * 0.75).toFixed(4)),
        },
        {
          model: "anthropic/claude-sonnet-4-6",
          totalTokens: Math.round(totalTokens * 0.3),
          totalCost: Number((totalCost * 0.25).toFixed(4)),
        },
      ],
      agents: [
        { agent: "main", totalTokens: Math.round(totalTokens * 0.65), totalCost },
        { agent: "research", totalTokens: Math.round(totalTokens * 0.35), totalCost: 0 },
      ],
      sources: [
        { source: "chat", totalTokens: Math.round(totalTokens * 0.55), totalCost },
        { source: "cron", totalTokens: Math.round(totalTokens * 0.45), totalCost: 0 },
      ],
    };
  });
  return { daily };
};

const createState = ({ mode = "dashboard", scenario = "healthy", port = 3001 } = {}) => {
  const effectiveScenario = mode === "setup" ? "setup" : scenario;
  const agents = effectiveScenario === "empty" ? [] : createAgents();
  const sessions = effectiveScenario === "empty" ? [] : createSessions();
  const webhooks = effectiveScenario === "empty" ? [] : createWebhooks(effectiveScenario);
  const cronJobs = effectiveScenario === "empty" ? [] : createCronJobs();
  const doctorCards = effectiveScenario === "empty" ? [] : createDoctorCards(effectiveScenario);
  return {
    mode,
    scenario: effectiveScenario,
    port,
    onboarded: mode !== "setup",
    envVars: createEnvVars(),
    agents,
    sessions,
    webhooks,
    webhookRequests: createWebhookRequests(effectiveScenario),
    cronJobs,
    doctorCards,
    watchdogSettings: { autoRepair: true, notifications: true },
    openAiCompatApiEnabled: true,
    claudeCliLoggedIn: true,
    claudeCliConfigured: false,
    restartRequired: effectiveScenario === "attention",
    terminal: {
      sessionId: "sandbox-terminal",
      output:
        "$ alphaclaw sandbox\nSandbox terminal output is synthetic.\nGateway health: ok\n",
      cursor: 0,
    },
  };
};

const buildStatus = (state) => {
  const attention = state.scenario === "attention";
  return {
    gateway: attention ? "starting" : "running",
    configExists: true,
    repo: "",
    openclawVersion: "2026.6.10-sandbox",
    alphaclawVersion: "0.9.18-sandbox",
    channels: {
      telegram: { status: "paired", configured: true, paired: 1 },
      discord: { status: state.scenario === "empty" ? "missing" : "configured" },
      slack: { status: "missing" },
      whatsapp: { status: "missing", accounts: {} },
    },
    alphaclaw: {
      features: {
        openAiCompatApi: { enabled: state.openAiCompatApiEnabled },
      },
    },
    syncCron: {
      enabled: false,
      schedule: "0 * * * *",
      installed: false,
      scriptExists: true,
    },
    uiSandbox: {
      enabled: true,
      scenario: state.scenario,
      mode: state.mode,
    },
  };
};

const buildWatchdogStatus = (state) => {
  const attention = state.scenario === "attention";
  return {
    health: attention ? "warning" : "healthy",
    lifecycle: attention ? "restarting" : "running",
    gatewayPid: attention ? null : 4242,
    operationInProgress: attention,
    restartCount: attention ? 2 : 0,
    lastCheckAt: iso(-30 * 1000),
    lastHealthyAt: attention ? iso(-12 * 60 * 1000) : iso(-30 * 1000),
    lastRepairAt: attention ? iso(-4 * 60 * 1000) : null,
    autoRepairEnabled: state.watchdogSettings.autoRepair,
    notificationsEnabled: state.watchdogSettings.notifications,
  };
};

const buildDoctorStatus = (state) => {
  const openCards = state.doctorCards.filter((card) => card.status === "open");
  return {
    lastRunAt: iso(-25 * 60 * 1000),
    running: false,
    openCards: openCards.length,
    warningCards: state.doctorCards.filter((card) => card.severity === "warning").length,
    errorCards: state.doctorCards.filter((card) => card.severity === "error").length,
    changeSummary: {
      changedFilesCount: state.scenario === "attention" ? 3 : 1,
      addedFilesCount: state.scenario === "attention" ? 1 : 0,
      deletedFilesCount: 0,
    },
  };
};

const buildUsageSummary = createUsageSummary;

module.exports = {
  clone,
  createState,
  buildStatus,
  buildWatchdogStatus,
  buildDoctorStatus,
  buildUsageSummary,
  kModels,
};
