#!/usr/bin/env node
"use strict";

const { createOAuthBrokerClient } = require("../lib/server/oauth-broker-client");

const kMinimumRemainingSeconds = 5 * 60;

const main = async () => {
  if (process.argv.length !== 3 || process.argv[2] !== "claude") {
    process.stderr.write("Unsupported OAuth lease consumer\n");
    process.exitCode = 2;
    return;
  }
  try {
    const response = await createOAuthBrokerClient().getClaudeAccessToken();
    if (
      response.expires_at <=
      Math.floor(Date.now() / 1000) + kMinimumRemainingSeconds
    ) {
      const error = new Error("OAuth lease expires too soon");
      error.code = "invalid_response";
      throw error;
    }
    process.stdout.write(response.access_token);
  } catch (error) {
    const code = /^[a-z0-9_]{1,80}$/.test(String(error?.code || ""))
      ? error.code
      : "broker_unavailable";
    process.stderr.write(`Claude OAuth lease unavailable (${code})\n`);
    process.exitCode = 1;
  }
};

main();
