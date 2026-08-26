const {
  buildChannelProviderAccessRequests,
  getChannelClassification,
  getChannelVaultConfig,
  getDiscordManagedProxyConfigValue,
  isChannelProviderShelved,
  listDeniedChannelPluginIds,
  listVaultBrokeredChannelProviders,
  resolveCatalogChannelIds,
} = require("../../lib/server/agent-vault/channel-provider-services");
const {
  normalizeAgentVaultAccessRequest,
  planAgentVaultAccess,
} = require("../../lib/agent-vault-access");
const {
  isVaultPlaceholderValue,
} = require("../../lib/server/agent-vault/model-provider-services");

describe("server/agent-vault/channel-provider-services", () => {
  it("classifies the four managed channels and nothing else", () => {
    expect(getChannelClassification("telegram")).toEqual({ tier: "S" });
    expect(getChannelClassification("discord")).toEqual({ tier: "S" });
    expect(getChannelClassification("slack")).toEqual({ tier: "S" });
    expect(getChannelClassification("whatsapp")).toEqual({ tier: "C" });
    expect(getChannelClassification("msteams")).toBeNull();
    expect(getChannelClassification("")).toBeNull();
    expect(listVaultBrokeredChannelProviders().sort()).toEqual([
      "discord",
      "slack",
      "telegram",
    ]);
  });

  it("every S-tier access request passes the real Agent Vault validators", () => {
    for (const provider of listVaultBrokeredChannelProviders()) {
      for (const accountId of ["default", "work"]) {
        const requests = buildChannelProviderAccessRequests(provider, accountId);
        for (const request of requests) {
          const access = normalizeAgentVaultAccessRequest(request);
          expect(access.service.auth).toEqual({ type: "passthrough" });
          const plan = planAgentVaultAccess(access, {
            services: [],
            available_credentials: [],
          });
          expect(plan.status).toBe("proposal_required");
        }
      }
    }
  });

  it("uses the Phase A canonical service names and surfaces", () => {
    expect(getChannelVaultConfig("telegram").services).toEqual([
      { name: "channel-telegram", host: "api.telegram.org" },
    ]);
    expect(getChannelVaultConfig("telegram").surfaces).toEqual(["path"]);
    expect(getChannelVaultConfig("discord").services).toEqual([
      { name: "channel-discord", host: "discord.com" },
      { name: "channel-discord-2", host: "gateway.discord.gg" },
    ]);
    expect(getChannelVaultConfig("discord").surfaces).toEqual([
      "header",
      "websocket",
    ]);
    expect(getChannelVaultConfig("slack").services).toEqual([
      { name: "channel-slack", host: "slack.com" },
    ]);
  });

  it("derives account-scoped slots and placeholders", () => {
    const defaults = getChannelVaultConfig("slack");
    expect(defaults.slots.map((slot) => slot.envKey)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
    expect(defaults.slots.map((slot) => slot.placeholder)).toEqual([
      "__agent_vault_slack_bot_token__",
      "__agent_vault_slack_app_token__",
    ]);
    const work = getChannelVaultConfig("slack", "work-team");
    expect(work.slots.map((slot) => slot.envKey)).toEqual([
      "SLACK_BOT_TOKEN_WORK_TEAM",
      "SLACK_APP_TOKEN_WORK_TEAM",
    ]);
    for (const slot of work.slots) {
      expect(isVaultPlaceholderValue(slot.placeholder)).toBe(true);
    }
    expect(getChannelVaultConfig("whatsapp")).toBeNull();
    expect(getChannelVaultConfig("msteams")).toBeNull();
  });

  it("substitutes every slot on every service in the requests", () => {
    const [discordCom, gateway] = buildChannelProviderAccessRequests("discord");
    expect(discordCom.service.substitutions).toEqual([
      {
        key: "DISCORD_BOT_TOKEN",
        placeholder: "__agent_vault_discord_bot_token__",
        in: ["header", "websocket"],
      },
    ]);
    expect(gateway.service.substitutions).toEqual(
      discordCom.service.substitutions,
    );
    const [slack] = buildChannelProviderAccessRequests("slack");
    expect(slack.service.substitutions).toHaveLength(2);
    expect(slack.credentials.map((credential) => credential.key)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
  });

  it("denies the unclassified catalog channels plus shelved ones (D6 default-closed)", () => {
    const denied = listDeniedChannelPluginIds();
    // The three vault-brokered channels stay available.
    for (const id of ["telegram", "discord", "slack"]) {
      expect(denied).not.toContain(id);
    }
    // WhatsApp is classified (Tier C) but shelved — denied despite being in
    // the vault-services registry, because it cannot link behind the MITM.
    expect(denied).toContain("whatsapp");
    expect(isChannelProviderShelved("whatsapp")).toBe(true);
    expect(isChannelProviderShelved("telegram")).toBe(false);
    expect(denied).toContain("msteams");
    expect(denied).toContain("signal");
    expect(denied).toContain("nostr");
    const catalog = new Set(resolveCatalogChannelIds());
    for (const id of denied) {
      expect(catalog.has(id)).toBe(true);
    }
  });

  it("keeps the discord proxy config value an env reference, never a URL", () => {
    expect(getDiscordManagedProxyConfigValue()).toBe("${OPENCLAW_PROXY_URL}");
  });
});
