"use strict";

// Narrow, version-pinned hotfixes Clawbridge applies to installed OpenClaw
// plugins while an upstream fix is pending. Each entry names the exact
// package version and the exact text it replaces; anything else (another
// version, the text missing or ambiguous) is left alone. Remove an entry as
// soon as the pinned OpenClaw release ships the upstream fix.

const fs = require("fs");
const path = require("path");

const kHotfixes = Object.freeze([
  {
    // G3 finding #22. @openclaw/slack 2026.9.5 hands OpenClaw's undici 8
    // env-proxy dispatcher (createHttp1EnvHttpProxyAgent) to
    // @slack/socket-mode 3.0.1, which opens its WebSocket with its own
    // undici 7. Whenever HTTP(S)_PROXY is set (every Agent Vault-managed
    // instance) the handshake fails at once and Socket Mode never connects.
    // The replacement builds the env-proxy dispatcher from Slack's own
    // undici (resolved next to the provider file, the copy Socket Mode
    // uses), as openclaw/openclaw#112963 originally did, so the WebSocket
    // still goes through the proxy (Agent Vault). Merely dropping the
    // dispatcher is not enough: Socket Mode's default is a direct Agent that
    // ignores HTTPS_PROXY. With no proxy env it passes nothing, as upstream.
    // Regression from openclaw/openclaw#147421 (merged 2026-09-14, first
    // released in 2026.9.5; 2026.9.4 shipped on 2026-09-11 without it).
    id: "slack-socket-mode-proxy-dispatcher",
    packageName: "@openclaw/slack",
    versions: ["2026.9.5"],
    fileDir: path.join("dist", ".setup"),
    filePattern: /^provider-[A-Za-z0-9_-]+\.mjs$/,
    find: "dispatcher: slackDispatcher,",
    replace:
      "dispatcher: /* clawbridge-hotfix:slack-socket-mode-proxy-dispatcher */ " +
      "(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) " +
      "? new (process.getBuiltinModule(\"node:module\").createRequire(import.meta.url)(\"undici\").EnvHttpProxyAgent)() " +
      ": void 0,",
  },
]);

const listDirs = (fsModule, dir) => {
  try {
    return fsModule
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

const findInstalledPackageDirs = ({ fsModule, openclawDir, packageName }) => {
  const parts = packageName.split("/");
  const dirs = [];
  for (const projectDir of listDirs(fsModule, path.join(openclawDir, "npm", "projects"))) {
    const candidate = path.join(projectDir, "node_modules", ...parts);
    if (fsModule.existsSync(path.join(candidate, "package.json"))) dirs.push(candidate);
  }
  const extension = path.join(openclawDir, "extensions", parts[parts.length - 1]);
  if (fsModule.existsSync(path.join(extension, "package.json"))) dirs.push(extension);
  return dirs;
};

const readPackageVersion = (fsModule, packageDir) => {
  try {
    return String(
      JSON.parse(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8"))
        ?.version || "",
    ).trim();
  } catch {
    return "";
  }
};

const countOccurrences = (text, needle) => text.split(needle).length - 1;

const applyOpenclawPluginHotfixes = ({
  openclawDir,
  fsModule = fs,
  logger = console,
  hotfixes = kHotfixes,
} = {}) => {
  const results = [];
  if (!openclawDir) return results;
  for (const hotfix of hotfixes) {
    for (const packageDir of findInstalledPackageDirs({
      fsModule,
      openclawDir,
      packageName: hotfix.packageName,
    })) {
      const version = readPackageVersion(fsModule, packageDir);
      if (!hotfix.versions.includes(version)) continue;
      let files = [];
      try {
        files = fsModule
          .readdirSync(path.join(packageDir, hotfix.fileDir))
          .filter((name) => hotfix.filePattern.test(name))
          .map((name) => path.join(packageDir, hotfix.fileDir, name));
      } catch {}
      let status = "not-applicable";
      for (const file of files) {
        let text;
        try {
          text = fsModule.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes(hotfix.replace)) {
          status = "already-applied";
          continue;
        }
        const occurrences = countOccurrences(text, hotfix.find);
        if (occurrences === 0) continue;
        if (occurrences > 1) {
          status = "ambiguous";
          logger.warn?.(
            `[alphaclaw] Hotfix ${hotfix.id} skipped: target text appears ${occurrences} times in ${file}`,
          );
          continue;
        }
        fsModule.writeFileSync(file, text.replace(hotfix.find, hotfix.replace));
        status = "applied";
        logger.log?.(
          `[alphaclaw] Applied OpenClaw plugin hotfix ${hotfix.id} to ${hotfix.packageName}@${version}`,
        );
      }
      results.push({ id: hotfix.id, packageDir, version, status });
    }
  }
  return results;
};

module.exports = {
  applyOpenclawPluginHotfixes,
  kOpenclawPluginHotfixes: kHotfixes,
};
