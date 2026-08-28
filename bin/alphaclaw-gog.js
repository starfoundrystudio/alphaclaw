#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { readGoogleState } = require("../lib/server/google-state");
const { createOAuthBrokerClient } = require("../lib/server/oauth-broker-client");

const kRealBinary =
  process.env.ALPHACLAW_GOG_REAL_BIN || "/usr/local/libexec/gog-real";
const kFlagsWithValues = new Set([
  "--account",
  "-a",
  "--client",
  "--home",
  "--color",
  "--enable-commands",
  "--enable-commands-exact",
  "--disable-commands",
  "--select",
  "--access-token",
]);
const kOfflineCommands = new Set([
  "completion",
  "help",
  "open",
  "schema",
  "time",
  "update",
]);
const kBlockedCommands = new Set(["auth", "login", "logout", "status"]);

const readFlag = (args, longName, shortName = "") => {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === longName || (shortName && value === shortName)) {
      return String(args[index + 1] || "").trim();
    }
    if (value.startsWith(`${longName}=`)) {
      return value.slice(longName.length + 1).trim();
    }
  }
  return "";
};

const firstCommand = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") return args[index + 1] || "";
    if (kFlagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return "";
};

const resolveStatePath = () => {
  const stateDir = String(process.env.OPENCLAW_STATE_DIR || "").trim();
  if (stateDir) return path.join(stateDir, "gogcli", "state.json");
  const home = String(process.env.HOME || "").trim();
  return path.join(home, ".alphaclaw", ".openclaw", "gogcli", "state.json");
};

const resolveBrokeredAccount = ({ args, state }) => {
  const requestedEmail =
    readFlag(args, "--account", "-a") || String(process.env.GOG_ACCOUNT || "").trim();
  const requestedClient =
    readFlag(args, "--client") || String(process.env.GOG_CLIENT || "").trim();
  let candidates = (state.accounts || []).filter(
    (account) => account.brokerConsumer && account.authenticated,
  );
  if (requestedEmail && requestedEmail !== "auto") {
    candidates = candidates.filter(
      (account) => account.email.toLowerCase() === requestedEmail.toLowerCase(),
    );
  }
  if (requestedClient) {
    candidates = candidates.filter((account) => account.client === requestedClient);
  }
  if (candidates.length === 1) return candidates[0];
  const error = new Error(
    candidates.length
      ? "Multiple brokered Google accounts match; pass --account and --client"
      : "No connected brokered Google account matches this command",
  );
  error.code = candidates.length ? "ambiguous_account" : "account_not_connected";
  throw error;
};

const buildInvocationArgs = (args, account) => {
  const invokedArgs = [...args];
  if (!readFlag(args, "--account", "-a")) {
    invokedArgs.unshift("--account", account.email);
  }
  if (!readFlag(args, "--client")) {
    invokedArgs.unshift("--client", account.client);
  }
  return invokedArgs;
};

const calculateLeaseRuntimeMs = ({ expiresAt, nowSeconds, leadSeconds }) => {
  const lead = Number.parseInt(String(leadSeconds || ""), 10);
  if (!Number.isFinite(lead) || lead <= 0) return 0;
  return Math.max(0, (expiresAt - nowSeconds - lead) * 1000);
};

const run = (args, env = process.env, { terminateAfterMs = 0 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(kRealBinary, args, { env, stdio: "inherit" });
    let leaseTimer = null;
    if (terminateAfterMs > 0) {
      leaseTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
      }, terminateAfterMs);
    }
    const forwardSignal = (signal) => {
      try {
        child.kill(signal);
      } catch {}
    };
    const forwardSigint = () => forwardSignal("SIGINT");
    const forwardSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (leaseTimer) clearTimeout(leaseTimer);
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      resolve(code ?? (signal ? 1 : 0));
    });
  });

const main = async () => {
  const args = process.argv.slice(2);
  const brokerClient = createOAuthBrokerClient();
  const bypass = process.env.ALPHACLAW_GOG_AUTH_BYPASS === "1";
  if (bypass) {
    const env = { ...process.env };
    delete env.ALPHACLAW_GOG_AUTH_BYPASS;
    delete env.GOG_ACCESS_TOKEN;
    process.exitCode = await run(args, env);
    return;
  }
  if (!brokerClient.isConfigured()) {
    process.exitCode = await run(args, process.env);
    return;
  }

  const command = firstCommand(args);
  if (
    !command ||
    args.includes("--help") ||
    args.includes("-h") ||
    args.includes("--version") ||
    kOfflineCommands.has(command)
  ) {
    const env = { ...process.env };
    delete env.GOG_ACCESS_TOKEN;
    process.exitCode = await run(args, env);
    return;
  }
  if (kBlockedCommands.has(command)) {
    process.stderr.write(
      "Manage Google Workspace OAuth connections from Clawbridge Google settings.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (readFlag(args, "--access-token") || process.env.GOG_ACCESS_TOKEN) {
    process.stderr.write(
      "Direct gog access-token overrides are disabled on this managed instance.\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const state = readGoogleState({ fs, statePath: resolveStatePath() });
    const account = resolveBrokeredAccount({ args, state });
    const lease = await brokerClient.getGogAccessToken({
      consumer: account.brokerConsumer,
    });
    if (lease.expires_at <= Math.floor(Date.now() / 1000) + 5 * 60) {
      const error = new Error("OAuth lease expires too soon");
      error.code = "invalid_response";
      throw error;
    }
    const env = {
      ...process.env,
      GOG_ACCESS_TOKEN: lease.access_token,
    };
    delete env.ALPHACLAW_GOG_AUTH_BYPASS;
    delete env.ALPHACLAW_GOG_RESTART_BEFORE_EXPIRY_SECONDS;
    const restartLeadSeconds =
      process.env.ALPHACLAW_GOG_RESTART_BEFORE_EXPIRY_SECONDS;
    const terminateAfterMs = calculateLeaseRuntimeMs({
      expiresAt: lease.expires_at,
      nowSeconds: Math.floor(Date.now() / 1000),
      leadSeconds: restartLeadSeconds,
    });
    if (Number.parseInt(String(restartLeadSeconds || ""), 10) > 0 && !terminateAfterMs) {
      const error = new Error("OAuth lease is too short for a long-running gog process");
      error.code = "invalid_response";
      throw error;
    }
    process.exitCode = await run(buildInvocationArgs(args, account), env, {
      terminateAfterMs,
    });
  } catch (error) {
    const code = /^[a-z0-9_]{1,80}$/.test(String(error?.code || ""))
      ? error.code
      : "broker_unavailable";
    process.stderr.write(`gog OAuth lease unavailable (${code})\n`);
    process.exitCode = 1;
  }
};

if (require.main === module) main();

module.exports = {
  buildInvocationArgs,
  calculateLeaseRuntimeMs,
  firstCommand,
  readFlag,
  resolveBrokeredAccount,
};
