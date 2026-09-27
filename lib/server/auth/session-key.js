const crypto = require("crypto");

const kSessionSecretEnvKey = "ALPHACLAW_SESSION_SECRET";
const kSessionSecretPattern = /^[A-Za-z0-9_-]{43,256}$/;

// Managed instances signed in through TeamYou have no SETUP_PASSWORD to sign
// sessions with, so they get a random per-instance secret persisted in .env
// (restores carry it along). Self-hosted installs without SSO never need one.
const ensureSessionSecret = ({
  env = process.env,
  ssoEnabled = false,
  readEnvFile,
  writeEnvFile,
  randomBytes = crypto.randomBytes,
} = {}) => {
  const existing = String(env[kSessionSecretEnvKey] || "").trim();
  if (kSessionSecretPattern.test(existing)) return existing;
  if (!ssoEnabled) return "";
  const secret = randomBytes(32).toString("base64url");
  try {
    const vars = (typeof readEnvFile === "function" ? readEnvFile() : []).filter(
      (entry) => entry?.key !== kSessionSecretEnvKey,
    );
    vars.push({ key: kSessionSecretEnvKey, value: secret });
    writeEnvFile(vars);
  } catch (error) {
    // Stay up with an in-memory secret: sessions just won't survive a restart.
    console.error(
      `[alphaclaw] Could not persist ${kSessionSecretEnvKey}: ${error.message}`,
    );
  }
  env[kSessionSecretEnvKey] = secret;
  return secret;
};

// Binding the password into the key keeps "change the password to revoke all
// sessions" working wherever a password exists. Without a session secret the
// key is the password itself, exactly as before, so self-hosted is unchanged.
const deriveSessionSigningKey = ({ sessionSecret = "", setupPassword = "" }) => {
  if (!sessionSecret) return String(setupPassword || "");
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(`clawbridge-session-v1:${String(setupPassword || "")}`)
    .digest("base64url");
};

module.exports = {
  kSessionSecretEnvKey,
  deriveSessionSigningKey,
  ensureSessionSecret,
};
