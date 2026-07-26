const upsertEnvVar = (items, key, value) => {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return items;
  const idx = items.findIndex((entry) => entry.key === normalizedKey);
  const nextEntry = { key: normalizedKey, value: String(value || "") };
  if (idx >= 0) {
    items[idx] = nextEntry;
  } else {
    items.push(nextEntry);
  }
  return items;
};

const getEnvVar = (items, key) =>
  (items || []).find((entry) => entry?.key === key)?.value || "";

const getEnvValue = (env = {}, envVars = [], keys = []) => {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  for (const key of keys) {
    const entryValue = String(getEnvVar(envVars, key) || "").trim();
    if (entryValue) return entryValue;
  }
  return "";
};

const normalizeDnsName = (value = "") =>
  String(value || "").trim().replace(/\.+$/, "");

module.exports = {
  getEnvValue,
  getEnvVar,
  normalizeDnsName,
  upsertEnvVar,
};
