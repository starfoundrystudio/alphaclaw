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
});
