const loadWelcomeStorage = async () =>
  import("../../lib/public/js/components/onboarding/use-welcome-storage.js");

describe("frontend/welcome-storage", () => {
  it("drops stale implicit Pi runtime defaults from persisted setup state", async () => {
    const welcomeStorage = await loadWelcomeStorage();
    const welcomeConfig = await import(
      "../../lib/public/js/components/onboarding/welcome-config.js"
    );

    const normalized = welcomeStorage.normalizeWelcomeStorageState({
      MODEL_KEY: "openai-codex/gpt-5.5",
      [welcomeConfig.kOpenAiCodexRouteKey]: welcomeConfig.kOpenAiCodexRoutePi,
    });

    expect(normalized[welcomeConfig.kOpenAiCodexRouteKey]).toBeUndefined();
  });

  it("preserves Pi runtime when the user explicitly selected it", async () => {
    const welcomeStorage = await loadWelcomeStorage();
    const welcomeConfig = await import(
      "../../lib/public/js/components/onboarding/welcome-config.js"
    );

    const normalized = welcomeStorage.normalizeWelcomeStorageState({
      MODEL_KEY: "openai-codex/gpt-5.5",
      [welcomeConfig.kOpenAiCodexRouteKey]: welcomeConfig.kOpenAiCodexRoutePi,
      [welcomeConfig.kOpenAiCodexRouteTouchedKey]: true,
    });

    expect(normalized[welcomeConfig.kOpenAiCodexRouteKey]).toBe(
      welcomeConfig.kOpenAiCodexRoutePi,
    );
  });

  it("drops transient Tailscale tokens from persisted setup state", async () => {
    const welcomeStorage = await loadWelcomeStorage();

    const normalized = welcomeStorage.normalizeWelcomeStorageState({
      MODEL_KEY: "openai/gpt-5.1-codex",
      TAILSCALE_API_TOKEN: "tskey-api-secret",
      _TAILSCALE_API_TOKEN: "tskey-api-secret",
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(normalized.MODEL_KEY).toBe("openai/gpt-5.1-codex");
    expect(normalized.TAILSCALE_API_TOKEN).toBeUndefined();
    expect(normalized._TAILSCALE_API_TOKEN).toBeUndefined();
    expect(normalized.tailscaleApiToken).toBeUndefined();
  });
});
