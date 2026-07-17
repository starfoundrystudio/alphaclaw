import {
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
});
