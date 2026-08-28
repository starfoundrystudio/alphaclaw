const CODEX_BROKER_CONSUMER = "openclaw-codex";
const CODEX_BROKER_PROVIDER = "openai";
const CODEX_BROKER_REFRESH_PLACEHOLDER =
  "alphaclaw-oauth-broker:v1:openclaw-codex:openai";

const CLAUDE_BROKER_CONSUMER = "claude-cli";
const CLAUDE_BROKER_PROVIDER = "anthropic";
const CLAUDE_BROKER_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_BROKER_REQUIRED_SCOPE = "user:inference";

const isBrokeredCodexCredential = (credential) =>
  credential?.type === "oauth" &&
  credential?.provider === CODEX_BROKER_PROVIDER &&
  credential?.refresh === CODEX_BROKER_REFRESH_PLACEHOLDER;

module.exports = {
  CLAUDE_BROKER_CLIENT_ID,
  CLAUDE_BROKER_CONSUMER,
  CLAUDE_BROKER_PROVIDER,
  CLAUDE_BROKER_REQUIRED_SCOPE,
  CODEX_BROKER_CONSUMER,
  CODEX_BROKER_PROVIDER,
  CODEX_BROKER_REFRESH_PLACEHOLDER,
  isBrokeredCodexCredential,
};
