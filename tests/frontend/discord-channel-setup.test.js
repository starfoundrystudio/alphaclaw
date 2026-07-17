import {
  isDiscordBotTokenShape,
  kDiscordDeveloperPortalUrl,
} from "../../lib/public/js/components/agents-tab/create-channel-modal/discord-setup.js";

describe("frontend/discord-channel-setup", () => {
  it("links to the official Discord Developer Portal", () => {
    expect(kDiscordDeveloperPortalUrl).toBe(
      "https://discord.com/developers/applications",
    );
  });

  it("rejects obviously partial bot tokens", () => {
    expect(isDiscordBotTokenShape("discord-secret-token-value")).toBe(true);
    expect(isDiscordBotTokenShape("partial")).toBe(false);
  });
});
