const loadWelcomeConfig = async () =>
  import("../../lib/public/js/components/onboarding/welcome-config.js");

describe("frontend/welcome-config", () => {
  it("includes only the required initial setup steps", async () => {
    const welcomeConfig = await loadWelcomeConfig();

    expect(welcomeConfig.kWelcomeGroups.map((group) => group.id)).toEqual([
      "ai",
      "tailscale",
    ]);
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
    ).toBe("Confirm that Tailscale is installed and signed in on this device.");
    expect(
      welcomeConfig.getWelcomeGroupError(
        welcomeConfig.kTailscaleGroupId,
        {},
        { tailscaleApiToken: "tskey-api-test_123", tailscaleClientReady: true },
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
