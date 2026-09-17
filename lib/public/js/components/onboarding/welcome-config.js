import { kAllAiAuthFields } from "../../lib/model-config.js";

export const kTailscaleGroupId = "tailscale";

const hasValue = (value) => !!String(value || "").trim();

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
      return "This account-login provider needs a provider-specific setup flow before Clawbridge can complete onboarding with it.";
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
