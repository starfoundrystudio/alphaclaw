const { normalizeChannelConfig } = require("../../lib/server/agents/shared");

describe("server/agents/shared normalizeChannelConfig", () => {
  it("keeps Agent Vault placeholders in channel token fields", () => {
    // G3 #35: managed channel config holds vault placeholders so a new
    // channel works without a Gateway restart; a later Clawbridge save must
    // not turn them back into env references the running Gateway lacks.
    const normalized = normalizeChannelConfig({
      provider: "slack",
      channelConfig: {
        accounts: {
          default: {
            botToken: "__agent_vault_slack_bot_token__",
            appToken: "__agent_vault_slack_app_token__",
          },
        },
      },
    });
    expect(normalized.accounts.default).toMatchObject({
      botToken: "__agent_vault_slack_bot_token__",
      appToken: "__agent_vault_slack_app_token__",
    });
  });

  it("still moves raw tokens behind env references", () => {
    const normalized = normalizeChannelConfig({
      provider: "telegram",
      channelConfig: { accounts: { default: { botToken: "123:raw" } } },
    });
    expect(normalized.accounts.default.botToken).toBe("${TELEGRAM_BOT_TOKEN}");
  });
});
