const loadWelcomeConfig = async () =>
  import("../../lib/public/js/components/onboarding/welcome-config.js");

describe("frontend/welcome-config", () => {
  it("does not include GitHub in the initial setup steps", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(welcomeConfig.kWelcomeGroups.map((group) => group.id)).not.toContain(
      "github",
    );
  });

  it("allows skipping GitHub entirely during a fresh setup", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError("github", {
        _GITHUB_FLOW: welcomeConfig.kGithubFlowFresh,
        GITHUB_TOKEN: "",
        GITHUB_WORKSPACE_REPO: "",
      }),
    ).toBe("");
  });

  it("reports a target repo format error for invalid GitHub input", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError("github", {
        GITHUB_TOKEN: "ghp_123",
        GITHUB_WORKSPACE_REPO: "owner-only",
      }),
    ).toBe('Target repo must be in "owner/repo" format.');
  });

  it("requires a token when a GitHub repo is provided for fresh setup", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError("github", {
        _GITHUB_FLOW: welcomeConfig.kGithubFlowFresh,
        GITHUB_TOKEN: "",
        GITHUB_WORKSPACE_REPO: "owner/repo",
      }),
    ).toBe("Enter a GitHub personal access token to continue.");
  });

  it("requires a source repo when import mode is selected", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError("github", {
        _GITHUB_FLOW: welcomeConfig.kGithubFlowImport,
        GITHUB_TOKEN: "ghp_123",
        GITHUB_WORKSPACE_REPO: "owner/target-repo",
        _GITHUB_SOURCE_REPO: "",
      }),
    ).toBe('Enter the source repo as "owner/repo".');
  });

  it("returns a Codex-specific auth message for the AI step", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError(
        "ai",
        { MODEL_KEY: "openai-codex/gpt-5.4" },
        {
          selectedProvider: "openai-codex",
          hasAi: false,
          codexLoading: false,
        },
      ),
    ).toBe("Connect Codex OAuth to continue.");
  });

  it("allows OpenAI models to use either API keys or Codex OAuth", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError(
        "ai",
        { MODEL_KEY: "openai/gpt-5.5" },
        {
          selectedProvider: "openai",
          hasAi: false,
          codexLoading: false,
        },
      ),
    ).toBe("Add an OpenAI API key or connect Codex OAuth to continue.");
  });

  it("requires both Slack tokens before the channels step can pass", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError("channels", {
        SLACK_BOT_TOKEN: "xoxb-123",
        SLACK_APP_TOKEN: "",
      }),
    ).toBe("Add the Slack app token to continue with Slack.");
  });

  it("allows skipping channels entirely during onboarding", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(welcomeConfig.getWelcomeGroupError("channels", {})).toBe("");
  });

  it("requires a Tailscale API access token before final setup", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(
      welcomeConfig.getWelcomeGroupError(
        welcomeConfig.kTailscaleGroupId,
        {},
        { tailscaleApiToken: "" },
      ),
    ).toBe("Enter a Tailscale API access token to continue.");
    expect(
      welcomeConfig.getWelcomeGroupError(
        welcomeConfig.kTailscaleGroupId,
        {},
        { tailscaleApiToken: "not-a-ts-key" },
      ),
    ).toBe("Tailscale API access token must start with tskey-api-.");
    expect(
      welcomeConfig.getWelcomeGroupError(
        welcomeConfig.kTailscaleGroupId,
        {},
        { tailscaleApiToken: "tskey-api-test_123" },
      ),
    ).toBe("");
  });

  it("finds the first invalid step in welcome order", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    const invalidGroup = welcomeConfig.findFirstInvalidWelcomeGroup(
      {
        MODEL_KEY: "openai-codex/gpt-5.4",
      },
      {
        selectedProvider: "openai-codex",
        hasAi: false,
        codexLoading: false,
      },
    );

    expect(invalidGroup?.id).toBe("ai");
  });
});
