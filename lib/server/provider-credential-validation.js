const kVercelAiGatewayApiKeyPrefix = "vck_";

const kCredentialRules = [
  {
    provider: "vercel-ai-gateway",
    envKey: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway API key",
    prefix: kVercelAiGatewayApiKeyPrefix,
  },
];

const getCredentialRule = ({ provider = "", envKey = "" } = {}) => {
  const normalizedProvider = String(provider || "").trim();
  const normalizedEnvKey = String(envKey || "").trim();
  return kCredentialRules.find(
    (rule) =>
      (normalizedEnvKey && rule.envKey === normalizedEnvKey) ||
      (normalizedProvider && rule.provider === normalizedProvider),
  );
};

const validateProviderCredentialValue = ({ provider = "", envKey = "", value = "" } = {}) => {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return { ok: true };
  const rule = getCredentialRule({ provider, envKey });
  if (!rule || normalizedValue.startsWith(rule.prefix)) return { ok: true };
  const name = envKey ? rule.envKey : rule.label;
  return {
    ok: false,
    status: 400,
    error: `${name} must start with ${rule.prefix}`,
  };
};

const validateEnvCredentialValues = (vars = []) => {
  for (const entry of vars || []) {
    const result = validateProviderCredentialValue({
      envKey: entry?.key,
      value: entry?.value,
    });
    if (!result.ok) return result;
  }
  return { ok: true };
};

const validateAuthProfileCredentialValues = (profiles = []) => {
  for (const profile of profiles || []) {
    const result = validateProviderCredentialValue({
      provider: profile?.provider,
      value: profile?.key || profile?.token || profile?.access || "",
    });
    if (!result.ok) return result;
  }
  return { ok: true };
};

module.exports = {
  kVercelAiGatewayApiKeyPrefix,
  validateProviderCredentialValue,
  validateEnvCredentialValues,
  validateAuthProfileCredentialValues,
};
