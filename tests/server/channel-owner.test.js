const {
  applyChannelOwnerSeed,
  isOwnerSeedProvider,
  normalizeChannelOwnerId,
} = require("../../lib/server/channel-owner");

describe("server/channel-owner", () => {
  it("normalizes the id formats OpenClaw accepts per channel", () => {
    expect(normalizeChannelOwnerId("slack", "<@u012abc>")).toBe("U012ABC");
    expect(normalizeChannelOwnerId("slack", "slack:W012ABC")).toBe("W012ABC");
    expect(normalizeChannelOwnerId("slack", "C012ABC")).toBe("");
    expect(normalizeChannelOwnerId("discord", "<@!123456789012345678>")).toBe(
      "123456789012345678",
    );
    expect(normalizeChannelOwnerId("telegram", "telegram:987654321")).toBe(
      "987654321",
    );
    // Negative Telegram ids are chats, never people.
    expect(normalizeChannelOwnerId("telegram", "-1001234")).toBe("");
    expect(normalizeChannelOwnerId("telegram", "@someone")).toBe("");
    expect(normalizeChannelOwnerId("whatsapp", "+15551234567")).toBe("");
  });

  it("only seeds the providers the setup modal supports", () => {
    expect(isOwnerSeedProvider("telegram")).toBe(true);
    expect(isOwnerSeedProvider("discord")).toBe(true);
    expect(isOwnerSeedProvider("slack")).toBe(true);
    expect(isOwnerSeedProvider("whatsapp")).toBe(false);
  });

  it("locks DMs to the owner and makes them a command owner", () => {
    const account = { dmPolicy: "pairing" };
    const cfg = { channels: { slack: { accounts: { default: account } } } };

    expect(
      applyChannelOwnerSeed({
        cfg,
        provider: "slack",
        account,
        ownerId: "u012abc",
      }),
    ).toBe(true);

    expect(account).toEqual({ dmPolicy: "allowlist", allowFrom: ["U012ABC"] });
    expect(cfg.commands).toEqual({ ownerAllowFrom: ["slack:U012ABC"] });
  });

  it("adds each channel identity to existing owners without duplicates", () => {
    const cfg = {
      commands: {
        native: "auto",
        ownerAllowFrom: ["telegram:987654321", "slack:U012ABC"],
      },
    };

    applyChannelOwnerSeed({
      cfg,
      provider: "slack",
      account: {},
      ownerId: "<@U012ABC>",
    });
    applyChannelOwnerSeed({
      cfg,
      provider: "discord",
      account: {},
      ownerId: "123456789012345678",
    });

    expect(cfg.commands).toEqual({
      native: "auto",
      ownerAllowFrom: [
        "telegram:987654321",
        "slack:U012ABC",
        "discord:123456789012345678",
      ],
    });
  });

  it("leaves config untouched for an invalid id", () => {
    const account = { dmPolicy: "pairing" };
    const cfg = {};
    expect(
      applyChannelOwnerSeed({ cfg, provider: "discord", account, ownerId: "abc" }),
    ).toBe(false);
    expect(account).toEqual({ dmPolicy: "pairing" });
    expect(cfg).toEqual({});
  });
});
