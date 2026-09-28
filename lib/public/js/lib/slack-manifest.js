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

// Slack Agent View (features.agent_view): new Slack apps can no longer use
// assistant_view. @openclaw/slack 2026.9.5+ detects Agent View on its own;
// agent_session_* power the native Stop button and title sync.
export const kSlackBotEvents = [
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
];

export const buildSlackManifest = (appName = "Clawbridge") =>
  JSON.stringify(
    {
      _metadata: {
        major_version: 2,
        minor_version: 1,
      },
      display_information: {
        name: String(appName || "").trim() || "Clawbridge",
        description: "Slack connector for Clawbridge",
      },
      features: {
        bot_user: {
          display_name: String(appName || "").trim() || "Clawbridge",
          always_online: true,
        },
        app_home: {
          home_tab_enabled: true,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        agent_view: {
          agent_description:
            "Clawbridge connects Slack Agent View conversations to OpenClaw agents.",
          suggested_prompts: kSlackSuggestedPrompts,
        },
        slash_commands: [
          {
            command: "/openclaw",
            description: "Send a message to Clawbridge",
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

export const buildSlackManifestUrl = (appName = "Clawbridge") => {
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", buildSlackManifest(appName));
  return url.toString();
};
