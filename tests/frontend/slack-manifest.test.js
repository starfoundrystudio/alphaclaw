const loadCreateChannelModalModule = async () =>
  import("../../lib/public/js/lib/slack-manifest.js");

describe("frontend/slack-manifest", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("builds the default Slack manifest for OpenClaw's assistant messaging experience", async () => {
    const { buildSlackManifest } = await loadCreateChannelModalModule();

    const manifest = JSON.parse(buildSlackManifest("Ops Agent"));

    expect(manifest.display_information).toMatchObject({
      name: "Ops Agent",
      description: "Slack connector for AlphaClaw",
    });
    expect(manifest.features.agent_view).toBeUndefined();
    expect(manifest.features.assistant_view).toMatchObject({
      assistant_description: "AlphaClaw connects Slack assistant threads to OpenClaw agents.",
      suggested_prompts: [
        {
          title: "What can you do?",
          message: "What can you help me with?",
        },
        {
          title: "Summarize this channel",
          message: "Summarize the recent activity in this channel.",
        },
        {
          title: "Draft a reply",
          message: "Help me draft a reply.",
        },
      ],
    });
    expect(manifest.features.app_home).toMatchObject({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/openclaw",
        description: "Send a message to AlphaClaw",
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
      "assistant_thread_context_changed",
      "assistant_thread_started",
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
});
