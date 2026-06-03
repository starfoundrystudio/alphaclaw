const loadWelcomeConfig = async () =>
  import("../../lib/public/js/components/onboarding/welcome-config.js");

describe("frontend/welcome-form-step", () => {
  it("shows optional OpenAI and Gemini credentials only on the Tools step", async () => {
    const { getOptionalToolCredentialVisibility } = await loadWelcomeConfig();

    expect(getOptionalToolCredentialVisibility("tailscale", {})).toEqual({
      openai: false,
      gemini: false,
    });
    expect(getOptionalToolCredentialVisibility("tools", {})).toEqual({
      openai: true,
      gemini: true,
    });
    expect(
      getOptionalToolCredentialVisibility("tools", {
        OPENAI_API_KEY: "sk-test",
        GEMINI_API_KEY: "AI-test",
      }),
    ).toEqual({
      openai: false,
      gemini: false,
    });
  });
});
