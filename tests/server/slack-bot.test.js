const {
  extractSlackScopes,
  inspectSlackCredentials,
  kSlackRequiredBotScopes,
  parseSlackAppIdFromAppToken,
} = require("../../lib/server/slack-bot");

const createSlackApiMock = ({ auth = {}, appError = null } = {}) =>
  vi.fn((token) => {
    if (String(token).startsWith("xapp-")) {
      return {
        openSocketConnection: vi.fn(async () => {
          if (appError) throw appError;
          return { ok: true, url: "wss://wss-primary.slack.com/private" };
        }),
      };
    }
    return {
      authTest: vi.fn(async () => ({
        ok: true,
        app_id: "A123ABC456",
        bot_id: "B123ABC456",
        user_id: "U123ABC456",
        user: "alpha-wolf",
        team_id: "T123ABC456",
        team: "Test Workspace",
        url: "https://test-workspace.slack.com/",
        response_metadata: { scopes: kSlackRequiredBotScopes.join(",") },
        ...auth,
      })),
      authScopes: vi.fn(async () => ({ ok: true })),
      appsPermissionsInfo: vi.fn(async () => ({ ok: true })),
    };
  });

describe("server/slack-bot", () => {
  it("keeps server scope verification aligned with the generated manifest", async () => {
    const { kSlackBotScopes } = await import(
      "../../lib/public/js/lib/slack-manifest.js"
    );

    expect(kSlackRequiredBotScopes).toEqual(kSlackBotScopes);
  });

  it("extracts scopes from Slack API response shapes", () => {
    expect(
      extractSlackScopes({
        scope: "chat:write,im:history",
        response_metadata: { scopes: ["channels:read"] },
      }),
    ).toEqual(["channels:read", "chat:write", "im:history"]);
  });

  it("extracts the app id encoded in an App-Level Token", () => {
    expect(parseSlackAppIdFromAppToken("xapp-1-A123ABC456-secret")).toBe(
      "A123ABC456",
    );
  });

  it("verifies matching bot and app tokens and returns safe identity details", async () => {
    const createApi = createSlackApiMock();

    await expect(
      inspectSlackCredentials(
        {
          botToken: "xoxb-1234567890-secret",
          appToken: "xapp-1-A123ABC456-secret",
        },
        { createApi },
      ),
    ).resolves.toEqual({
      appId: "A123ABC456",
      appSettingsUrl: "https://api.slack.com/apps/A123ABC456",
      workspace: {
        id: "T123ABC456",
        name: "Test Workspace",
        url: "https://test-workspace.slack.com/",
      },
      bot: {
        id: "B123ABC456",
        userId: "U123ABC456",
        name: "alpha-wolf",
      },
      scopes: {
        checked: true,
        granted: [...kSlackRequiredBotScopes].sort(),
        missing: [],
      },
    });
  });

  it("reports missing bot scopes precisely", async () => {
    const createApi = createSlackApiMock({
      auth: { response_metadata: { scopes: "chat:write,im:history" } },
    });

    const result = await inspectSlackCredentials(
      {
        botToken: "xoxb-1234567890-secret",
        appToken: "xapp-1-A123ABC456-secret",
      },
      { createApi },
    );

    expect(result.scopes.checked).toBe(true);
    expect(result.scopes.missing).toContain("assistant:write");
    expect(result.scopes.missing).not.toContain("chat:write");
  });

  it("rejects credentials belonging to different Slack apps", async () => {
    await expect(
      inspectSlackCredentials(
        {
          botToken: "xoxb-1234567890-secret",
          appToken: "xapp-1-A999XYZ999-secret",
        },
        { createApi: createSlackApiMock() },
      ),
    ).rejects.toThrow("belong to different Slack apps");
  });

  it("explains when the app token lacks connections:write", async () => {
    const appError = new Error("missing_scope");
    appError.slackError = "missing_scope";

    await expect(
      inspectSlackCredentials(
        {
          botToken: "xoxb-1234567890-secret",
          appToken: "xapp-1-A123ABC456-secret",
        },
        { createApi: createSlackApiMock({ appError }) },
      ),
    ).rejects.toThrow("missing connections:write");
  });
});
