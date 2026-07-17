import {
  buildSlackConversationUrl,
  isSlackAppTokenShape,
  isSlackBotTokenShape,
} from "../../lib/public/js/components/agents-tab/create-channel-modal/slack-setup.js";

describe("frontend/slack-channel-setup", () => {
  it("distinguishes Slack bot and App-Level token prefixes", () => {
    expect(isSlackBotTokenShape("xoxb-1234567890-secret")).toBe(true);
    expect(isSlackBotTokenShape("xapp-1-A123-secret")).toBe(false);
    expect(isSlackAppTokenShape("xapp-1-A123ABC456-secret")).toBe(true);
    expect(isSlackAppTokenShape("xoxb-1234567890-secret")).toBe(false);
  });

  it("builds a direct Slack app conversation URL", () => {
    const url = new URL(
      buildSlackConversationUrl({ appId: "A123ABC456", teamId: "T123ABC456" }),
    );

    expect(url.origin).toBe("https://slack.com");
    expect(url.pathname).toBe("/app_redirect");
    expect(url.searchParams.get("app")).toBe("A123ABC456");
    expect(url.searchParams.get("team")).toBe("T123ABC456");
  });

  it("does not build a conversation URL without a verified app ID", () => {
    expect(buildSlackConversationUrl({ teamId: "T123ABC456" })).toBe("");
  });
});
