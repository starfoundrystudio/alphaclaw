const loadWelcomeStorage = async () =>
  import("../../lib/public/js/components/onboarding/use-welcome-storage.js");

describe("frontend/welcome-storage", () => {
  it("drops stale OpenAI Codex route choices from persisted setup state", async () => {
    const welcomeStorage = await loadWelcomeStorage();

    const normalized = welcomeStorage.normalizeWelcomeStorageState({
      MODEL_KEY: "openai/gpt-5.5",
      _OPENAI_CODEX_ROUTE: "pi",
      _OPENAI_CODEX_ROUTE_TOUCHED: true,
    });

    expect(normalized.MODEL_KEY).toBe("openai/gpt-5.5");
    expect(normalized._OPENAI_CODEX_ROUTE).toBeUndefined();
    expect(normalized._OPENAI_CODEX_ROUTE_TOUCHED).toBeUndefined();
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

  it("drops invalid model access modes from persisted setup state", async () => {
    const welcomeStorage = await loadWelcomeStorage();

    const normalized = welcomeStorage.normalizeWelcomeStorageState({
      MODEL_KEY: "openai/gpt-5.5",
      _MODEL_ACCESS_MODE: "legacy-mode",
    });

    expect(normalized.MODEL_KEY).toBe("openai/gpt-5.5");
    expect(normalized._MODEL_ACCESS_MODE).toBeUndefined();
  });
});
