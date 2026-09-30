const { isCloudflareTunnelMode } = require("../../ingress-mode");

// Until teamyou.io is on the Public Suffix List, every tunnel instance is the
// same site as every other, and a sibling instance could plant a
// Domain=teamyou.io cookie that shadows or fixes this instance's session.
// The __Host- prefix forbids Domain and requires Secure and Path=/, so tunnel
// instances use it for both auth cookies. Tailscale instances keep the
// historical names so existing sessions survive.
const kSessionCookieName = "setup_token";
const kAdvancedControlCookieBaseName = "alphaclaw_advanced_access";
const kHostCookiePrefix = "__Host-";

const usesHostPrefixedCookies = (env = process.env) =>
  isCloudflareTunnelMode({ env });

const getSessionCookieName = (env = process.env) =>
  usesHostPrefixedCookies(env)
    ? `${kHostCookiePrefix}${kSessionCookieName}`
    : kSessionCookieName;

const getAdvancedControlCookieName = (env = process.env) =>
  usesHostPrefixedCookies(env)
    ? `${kHostCookiePrefix}${kAdvancedControlCookieBaseName}`
    : kAdvancedControlCookieBaseName;

// Attributes every write and clear of these cookies must carry. __Host-
// cookies are rejected by browsers unless Secure and Path=/ with no Domain.
const getAuthCookieBaseOptions = (req, env = process.env) => ({
  path: "/",
  secure: usesHostPrefixedCookies(env) ? true : req?.secure === true,
});

module.exports = {
  getAdvancedControlCookieName,
  getAuthCookieBaseOptions,
  getSessionCookieName,
  kAdvancedControlCookieBaseName,
  kSessionCookieName,
  usesHostPrefixedCookies,
};
