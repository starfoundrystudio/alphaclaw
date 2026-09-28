const loadCreateChannelModalModule = async () =>
  import("../../lib/public/js/lib/slack-manifest.js");

describe("frontend/slack-manifest", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("builds the default Slack manifest for Slack's Agent View experience", async () => {
    const { buildSlackManifest } = await loadCreateChannelModalModule();

    const manifest = JSON.parse(buildSlackManifest("Ops Agent"));

    expect(manifest.display_information).toMatchObject({
      name: "Ops Agent",
      description: "Slack connector for Clawbridge",
    });
    expect(manifest.features.assistant_view).toBeUndefined();
    expect(manifest.features.agent_view).toEqual({
      agent_description:
        "Clawbridge connects Slack Agent View conversations to OpenClaw agents.",
    });
    expect(manifest.features.app_home).toMatchObject({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/openclaw",
        description: "Send a message to Clawbridge",
        should_escape: false,
      },
    ]);
    expect(manifest.oauth_config.scopes.bot).toEqual([
      "app_mentions:read",
      "assistant:write",
      "channels:history",
      "channels:read",
      "chat:write",
      "commands",
      "emoji:read",
      "files:read",
      "files:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "mpim:write",
      "pins:read",
      "pins:write",
      "reactions:read",
      "reactions:write",
      "usergroups:read",
      "users:read",
    ]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity).toEqual({ is_enabled: true });
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_home_opened",
      "app_mention",
      "app_context_changed",
      "agent_session_stopped",
      "agent_session_title_changed",
      "channel_rename",
      "member_joined_channel",
      "member_left_channel",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "pin_added",
      "pin_removed",
      "reaction_added",
      "reaction_removed",
    ]);
  });

  it("builds an official Slack app-creation URL with the manifest embedded", async () => {
    const { buildSlackManifestUrl } = await loadCreateChannelModalModule();

    const url = new URL(buildSlackManifestUrl("Ops Agent"));
    const manifest = JSON.parse(url.searchParams.get("manifest_json"));

    expect(url.origin).toBe("https://api.slack.com");
    expect(url.pathname).toBe("/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(manifest.display_information.name).toBe("Ops Agent");
    expect(manifest.features.agent_view).toBeDefined();
    expect(manifest.features.assistant_view).toBeUndefined();
  });
});
