export const kSlackSuggestedPrompts = [
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
];

export const kSlackBotScopes = [
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
];

export const kSlackBotEvents = [
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
];

export const buildSlackManifest = (appName = "AlphaClaw") =>
  JSON.stringify(
    {
      _metadata: {
        major_version: 2,
        minor_version: 1,
      },
      display_information: {
        name: String(appName || "").trim() || "AlphaClaw",
        description: "Slack connector for AlphaClaw",
      },
      features: {
        bot_user: {
          display_name: String(appName || "").trim() || "AlphaClaw",
          always_online: true,
        },
        app_home: {
          home_tab_enabled: true,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        assistant_view: {
          assistant_description:
            "AlphaClaw connects Slack assistant threads to OpenClaw agents.",
          suggested_prompts: kSlackSuggestedPrompts,
        },
        slash_commands: [
          {
            command: "/openclaw",
            description: "Send a message to AlphaClaw",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: kSlackBotScopes,
        },
      },
      settings: {
        socket_mode_enabled: true,
        event_subscriptions: {
          bot_events: kSlackBotEvents,
        },
        interactivity: {
          is_enabled: true,
        },
        org_deploy_enabled: false,
        is_hosted: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
