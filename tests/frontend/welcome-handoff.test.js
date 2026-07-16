const loadWelcomeHook = async () =>
  import("../../lib/public/js/components/welcome/use-welcome.js");

describe("frontend/welcome handoff", () => {
  it("excludes retired channel credentials from onboarding submissions", async () => {
    const { buildOnboardingVars } = await loadWelcomeHook();

    expect(
      buildOnboardingVars({
        MODEL_KEY: "openai/gpt-5.5",
        OPENAI_API_KEY: "sk-test",
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        DISCORD_BOT_TOKEN: "discord-secret",
        SLACK_BOT_TOKEN: "xoxb-secret",
        SLACK_APP_TOKEN: "xapp-secret",
        WHATSAPP_OWNER_NUMBER: "+15551234567",
      }),
    ).toEqual([{ key: "OPENAI_API_KEY", value: "sk-test" }]);
  });

  it("builds a dashboard redirect URL from the final setup URL", async () => {
    const { buildSetupRedirectUrl } = await loadWelcomeHook();

    expect(buildSetupRedirectUrl("https://alphaclaw.tail123.ts.net")).toBe(
      "https://alphaclaw.tail123.ts.net/#/general",
    );
    expect(buildSetupRedirectUrl("not a url")).toBe("");
  });

  it("redirects only when the final setup origin differs", async () => {
    const { shouldRedirectToSetupUrl } = await loadWelcomeHook();

    expect(
      shouldRedirectToSetupUrl(
        "https://alphaclaw.tail123.ts.net",
        "https://bootstrap.openclaw.teamyou.ai",
      ),
    ).toBe(true);
    expect(
      shouldRedirectToSetupUrl(
        "https://alphaclaw.tail123.ts.net",
        "https://alphaclaw.tail123.ts.net",
      ),
    ).toBe(false);
  });

  it("returns the final setup redirect URL from an onboarding result", async () => {
    const { getSetupRedirectUrlForOnboardResult } = await loadWelcomeHook();

    expect(
      getSetupRedirectUrlForOnboardResult(
        { setupUrl: "https://alphaclaw.tail123.ts.net" },
        "https://bootstrap.openclaw.teamyou.ai",
      ),
    ).toBe("https://alphaclaw.tail123.ts.net/#/general");
    expect(
      getSetupRedirectUrlForOnboardResult(
        { setupUrl: "https://alphaclaw.tail123.ts.net" },
        "https://alphaclaw.tail123.ts.net",
      ),
    ).toBe("");
  });

  it("requires a final setup URL before leaving onboarding", async () => {
    const { requireFinalSetupUrl } = await loadWelcomeHook();

    expect(() =>
      requireFinalSetupUrl({ setupUrl: "https://alphaclaw.tail123.ts.net" }),
    ).not.toThrow();
    expect(() => requireFinalSetupUrl({ ok: true })).toThrow(
      "final Tailscale URL",
    );
  });

  it("probes the redirect target without requiring CORS", async () => {
    const { probeSetupRedirectTarget } = await loadWelcomeHook();
    const fetchImpl = vi.fn(async () => ({}));

    await expect(
      probeSetupRedirectTarget("https://alphaclaw.tail123.ts.net/#/general", {
        fetchImpl,
        timeoutMs: 0,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://alphaclaw.tail123.ts.net/#/general",
      expect.objectContaining({
        mode: "no-cors",
        cache: "no-store",
      }),
    );
  });

  it("keeps the transition screen available when probing fails", async () => {
    const { probeSetupRedirectTarget } = await loadWelcomeHook();
    const fetchImpl = vi.fn(async () => {
      throw new Error("not reachable");
    });

    await expect(
      probeSetupRedirectTarget("https://alphaclaw.tail123.ts.net/#/general", {
        fetchImpl,
        timeoutMs: 0,
      }),
    ).resolves.toBe(false);
  });

  it("recognizes interrupted final onboarding responses as recoverable", async () => {
    const { isRecoverableOnboardCompletionError } = await loadWelcomeHook();
    const emptyResponseError = new Error("empty");
    emptyResponseError.code = "ONBOARD_RESPONSE_EMPTY";

    expect(isRecoverableOnboardCompletionError(emptyResponseError)).toBe(true);
    expect(
      isRecoverableOnboardCompletionError(
        new Error("Unexpected end of JSON input"),
      ),
    ).toBe(true);
    expect(isRecoverableOnboardCompletionError(new Error("Bad token"))).toBe(
      false,
    );
  });

  it("polls onboarding status until completion is visible", async () => {
    const { waitForOnboardingCompletion } = await loadWelcomeHook();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ onboarded: false })
      .mockResolvedValueOnce({ onboarded: true });

    await expect(
      waitForOnboardingCompletion({
        fetchStatus,
        attempts: 3,
        intervalMs: 0,
      }),
    ).resolves.toEqual({ onboarded: true });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});
