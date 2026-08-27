const CODEX_BROKER_CONSUMER = "openclaw-codex";
const CODEX_BROKER_PROVIDER = "openai";
const CODEX_BROKER_REFRESH_PLACEHOLDER =
  "alphaclaw-oauth-broker:v1:openclaw-codex:openai";

const isBrokeredCodexCredential = (credential) =>
  credential?.type === "oauth" &&
  credential?.provider === CODEX_BROKER_PROVIDER &&
  credential?.refresh === CODEX_BROKER_REFRESH_PLACEHOLDER;

module.exports = {
  CODEX_BROKER_CONSUMER,
  CODEX_BROKER_PROVIDER,
  CODEX_BROKER_REFRESH_PLACEHOLDER,
  isBrokeredCodexCredential,
};
