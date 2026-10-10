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

describe("server/discord-bot owner", () => {
  const { resolveDiscordApplicationOwner } = require("../../lib/server/discord-bot");

  it("reports the application owner as the channel owner", () => {
    expect(
      resolveDiscordApplicationOwner({
        owner: {
          id: "111111111111111111",
          username: "billk",
          global_name: "Bill",
          avatar: "abc",
          flags: 0,
        },
      }),
    ).toEqual({
      owner: {
        id: "111111111111111111",
        username: "billk",
        name: "Bill",
        avatarUrl:
          "https://cdn.discordapp.com/avatars/111111111111111111/abc.png?size=64",
      },
      ownerCandidates: [expect.objectContaining({ id: "111111111111111111" })],
    });
  });

  it("uses the team owner for team-owned apps and offers accepted members", () => {
    const result = resolveDiscordApplicationOwner({
      owner: { id: "999999999999999999", username: "team123", flags: 1 << 10 },
      team: {
        owner_user_id: "222222222222222222",
        members: [
          {
            membership_state: 2,
            user: { id: "333333333333333333", username: "dev" },
          },
          {
            membership_state: 2,
            user: { id: "222222222222222222", username: "owner" },
          },
          {
            membership_state: 1,
            user: { id: "444444444444444444", username: "invited" },
          },
        ],
      },
    });

    expect(result.owner).toEqual(
      expect.objectContaining({ id: "222222222222222222", username: "owner" }),
    );
    expect(result.ownerCandidates.map((candidate) => candidate.id)).toEqual([
      "222222222222222222",
      "333333333333333333",
    ]);
  });

  it("never treats the team pseudo-user as a person", () => {
    expect(
      resolveDiscordApplicationOwner({
        owner: { id: "999999999999999999", username: "team123", flags: 1 << 10 },
      }),
    ).toEqual({ owner: null, ownerCandidates: [] });
  });

  it("includes the owner in the token inspection", async () => {
    const createApi = vi.fn(() => ({
      getCurrentUser: vi.fn(async () => ({
        id: "123456789012345678",
        username: "alpha-wolf",
        bot: true,
      })),
      getCurrentApplication: vi.fn(async () => ({
        id: "123456789012345678",
        flags: 1 << 19,
        owner: { id: "111111111111111111", username: "billk" },
      })),
      listCurrentUserGuilds: vi.fn(async () => []),
    }));

    const bot = await inspectDiscordBotToken("discord-secret-token-value", {
      createApi,
    });
    expect(bot.owner).toEqual(
      expect.objectContaining({ id: "111111111111111111", username: "billk" }),
    );
  });
});
