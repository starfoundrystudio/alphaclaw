import { kAllAiAuthFields } from "../../lib/model-config.js";

export const kRepoModeNew = "new";
export const kRepoModeExisting = "existing";
export const kGithubFlowFresh = "fresh";
export const kGithubFlowImport = "import";
export const kGithubTargetRepoModeCreate = "create";
export const kGithubTargetRepoModeExistingEmpty = "existing-empty";
export const kTailscaleGroupId = "tailscale";

const hasValue = (value) => !!String(value || "").trim();

export const hasAnyGithubBackupInput = (vals = {}) =>
  hasValue(vals.GITHUB_TOKEN) || hasValue(vals.GITHUB_WORKSPACE_REPO);

export const hasGithubBackupConfig = (vals = {}) =>
  hasValue(vals.GITHUB_TOKEN) && hasValue(vals.GITHUB_WORKSPACE_REPO);

export const normalizeGithubRepoInput = (repoInput) =>
  String(repoInput || "")
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");

export const isValidGithubRepoInput = (repoInput) => {
  const cleaned = normalizeGithubRepoInput(repoInput);
  if (!cleaned) return false;
  const parts = cleaned.split("/").filter(Boolean);
  return parts.length === 2 && !parts.some((part) => /\s/.test(part));
};

const getGithubGroupError = (vals) => {
  const githubFlow = vals._GITHUB_FLOW || kGithubFlowFresh;
  const requiresGithub = githubFlow === kGithubFlowImport;
  const hasAnyGithubInput = hasAnyGithubBackupInput(vals);

  if (!requiresGithub && !hasAnyGithubInput) {
    return "";
  }
  if (!hasValue(vals.GITHUB_TOKEN)) {
    return "Enter a GitHub personal access token to continue.";
  }
  if (!hasValue(vals.GITHUB_WORKSPACE_REPO)) {
    return 'Enter the target repo as "owner/repo".';
  }
  if (!isValidGithubRepoInput(vals.GITHUB_WORKSPACE_REPO)) {
    return 'Target repo must be in "owner/repo" format.';
  }
  if (githubFlow === kGithubFlowImport) {
    if (!hasValue(vals._GITHUB_SOURCE_REPO)) {
      return 'Enter the source repo as "owner/repo".';
    }
    if (!isValidGithubRepoInput(vals._GITHUB_SOURCE_REPO)) {
      return 'Source repo must be in "owner/repo" format.';
    }
  }
  return "";
};

const getAiGroupError = (vals, ctx = {}) => {
  if (!hasValue(vals.MODEL_KEY) || !String(vals.MODEL_KEY).includes("/")) {
    return "Choose a model to continue.";
  }
  if (
    (ctx.selectedProvider === "openai-codex" ||
      (ctx.selectedProvider === "openai" && !hasValue(vals.OPENAI_API_KEY))) &&
    ctx.codexLoading
  ) {
    return "Checking Codex OAuth status. Try Next again in a moment.";
  }
  if (ctx.credentialError) {
    return ctx.credentialError;
  }
  if (!ctx.hasAi) {
    if (ctx.accountLoginNeedsSetup) {
      return "This account-login provider needs a provider-specific setup flow before AlphaClaw can complete onboarding with it.";
    }
    if (ctx.selectedProvider === "openai-codex") {
      return "Connect Codex OAuth to continue.";
    }
    if (ctx.selectedProvider === "openai") {
      return "Add an OpenAI API key or connect Codex OAuth to continue.";
    }
    if (ctx.selectedProvider === "claude-cli") {
      return "Connect Claude CLI to continue.";
    }
    return "Add credentials for the selected model provider to continue.";
  }
  return "";
};

const getTailscaleGroupError = (ctx = {}) => {
  const token = String(ctx.tailscaleApiToken || "").trim();
  if (!token) return "Enter a Tailscale API access token to continue.";
  if (!token.startsWith("tskey-api-")) {
    return "Tailscale API access token must start with tskey-api-.";
  }
  if (!ctx.tailscaleClientReady) {
    return "Confirm that Tailscale is installed and signed in on this device.";
  }
  return "";
};

export const getWelcomeGroupError = (groupId, vals, ctx = {}) => {
  switch (groupId) {
    case "github":
      return getGithubGroupError(vals);
    case "ai":
      return getAiGroupError(vals, ctx);
    case kTailscaleGroupId:
      return getTailscaleGroupError(ctx);
    default:
      return "";
  }
};

export const kWelcomeGroups = [
  {
    id: "ai",
    title: "Primary Agent Model",
    description: "Choose your main model and authenticate its provider",
    fields: kAllAiAuthFields,
    validate: (vals, ctx = {}) => !getWelcomeGroupError("ai", vals, ctx),
  },
  {
    id: kTailscaleGroupId,
    title: "Private Access With Tailscale",
    description: "",
    fields: [],
    validate: (vals, ctx = {}) => !getWelcomeGroupError(kTailscaleGroupId, vals, ctx),
  },
];

export const findFirstInvalidWelcomeGroup = (vals, ctx = {}) =>
  kWelcomeGroups.find((group) => getWelcomeGroupError(group.id, vals, ctx)) || null;
