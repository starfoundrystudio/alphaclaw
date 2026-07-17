const {
  buildDiscordInstallUrl,
  inspectDiscordBotToken,
  kDiscordInstallPermissions,
  kDiscordPermissionFlags,
} = require("../../lib/server/discord-bot");

describe("server/discord-bot", () => {
  it("builds an install URL with OpenClaw scopes and permissions preselected", () => {
    const installUrl = new URL(buildDiscordInstallUrl("123456789012345678"));

    expect(installUrl.origin).toBe("https://discord.com");
    expect(installUrl.pathname).toBe("/oauth2/authorize");
    expect(installUrl.searchParams.get("client_id")).toBe(
      "123456789012345678",
    );
    expect(installUrl.searchParams.get("scope")).toBe(
      "bot applications.commands",
    );
    expect(installUrl.searchParams.get("integration_type")).toBe("0");
    expect(installUrl.searchParams.get("permissions")).toBe(
      kDiscordInstallPermissions.toString(),
    );
    expect(
      kDiscordInstallPermissions & kDiscordPermissionFlags.sendMessagesInThreads,
    ).toBe(kDiscordPermissionFlags.sendMessagesInThreads);
  });

  it("returns bot identity, intent state, and installed servers", async () => {
    const createApi = vi.fn(() => ({
      getCurrentUser: vi.fn(async () => ({
        id: "123456789012345678",
        username: "alpha-wolf",
        global_name: "Alpha Wolf",
        avatar: "avatar-hash",
        bot: true,
      })),
      getCurrentApplication: vi.fn(async () => ({
        id: "123456789012345678",
        name: "Alpha Wolf",
        flags: (1 << 19) | (1 << 15),
      })),
      listCurrentUserGuilds: vi.fn(async () => [
        { id: "234567890123456789", name: "Test Server" },
      ]),
    }));

    await expect(
      inspectDiscordBotToken("discord-secret-token-value", { createApi }),
    ).resolves.toEqual(
      expect.objectContaining({
        applicationId: "123456789012345678",
        name: "Alpha Wolf",
        username: "alpha-wolf",
        intents: { messageContent: true, guildMembers: true },
        guilds: [{ id: "234567890123456789", name: "Test Server" }],
      }),
    );
  });

  it("turns Discord authentication failures into actionable copy", async () => {
    const discordError = new Error("401: Unauthorized");
    discordError.discordStatusCode = 401;

    await expect(
      inspectDiscordBotToken("discord-secret-token-value", {
        createApi: () => ({
          getCurrentUser: vi.fn(async () => {
            throw discordError;
          }),
          getCurrentApplication: vi.fn(async () => {
            throw discordError;
          }),
          listCurrentUserGuilds: vi.fn(async () => {
            throw discordError;
          }),
        }),
      }),
    ).rejects.toThrow("Discord rejected this bot token");
  });
});
