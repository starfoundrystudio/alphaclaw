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

  it("builds a cache-busted probe URL on the final origin", async () => {
    const { buildInstanceProbeUrl } = await loadWelcomeHook();

    expect(buildInstanceProbeUrl("https://alphaclaw.tail123.ts.net", 3)).toBe(
      "https://alphaclaw.tail123.ts.net/api/onboard/runtime-ready.svg?ready-probe=3",
    );
    expect(buildInstanceProbeUrl("not a url")).toBe("");
  });

  it("treats a decodable image as the only readiness signal", async () => {
    const { probeInstanceReady } = await loadWelcomeHook();
    const makeImage = (fire) => () => {
      const image = {};
      Object.defineProperty(image, "src", {
        set() {
          queueMicrotask(() => image[fire]?.());
        },
      });
      return image;
    };

    await expect(
      probeInstanceReady("https://alphaclaw.tail123.ts.net", {
        createImage: makeImage("onload"),
      }),
    ).resolves.toBe(true);
    // A 502 error page or a closed connection both fail image decoding.
    await expect(
      probeInstanceReady("https://alphaclaw.tail123.ts.net", {
        createImage: makeImage("onerror"),
      }),
    ).resolves.toBe(false);
    await expect(
      probeInstanceReady("not a url", {
        createImage: makeImage("onload"),
      }),
    ).resolves.toBe(false);
  });

  it("times out unanswered probes", async () => {
    const { probeInstanceReady } = await loadWelcomeHook();

    await expect(
      probeInstanceReady("https://alphaclaw.tail123.ts.net", {
        createImage: () => ({}),
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  });

  it("requires consecutive successful probes before declaring readiness", async () => {
    const { waitForInstanceReady } = await loadWelcomeHook();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await expect(
      waitForInstanceReady({
        setupUrl: "https://alphaclaw.tail123.ts.net",
        probe,
        waitMs: async () => {},
        initialDelayMs: 0,
        intervalMs: 0,
        requiredSuccesses: 2,
      }),
    ).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("switches to the tailnet hint once, then keeps polling until cancelled", async () => {
    const { waitForInstanceReady } = await loadWelcomeHook();
    const onTailnetHint = vi.fn();
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return false;
    });

    await expect(
      waitForInstanceReady({
        setupUrl: "https://alphaclaw.tail123.ts.net",
        probe,
        waitMs: async () => {},
        initialDelayMs: 0,
        intervalMs: 0,
        tailnetHintDelayMs: 0,
        onTailnetHint,
        isCancelled: () => calls >= 5,
      }),
    ).resolves.toBe(false);
    expect(onTailnetHint).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("reports a slow gateway start once while continuing to poll", async () => {
    const { waitForInstanceReady } = await loadWelcomeHook();
    const onSlowStart = vi.fn();
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return false;
    });

    await expect(
      waitForInstanceReady({
        setupUrl: "https://alphaclaw.tail123.ts.net",
        probe,
        waitMs: async () => {},
        initialDelayMs: 0,
        intervalMs: 0,
        slowStartHintDelayMs: 0,
        tailnetHintDelayMs: Number.MAX_SAFE_INTEGER,
        onSlowStart,
        isCancelled: () => calls >= 5,
      }),
    ).resolves.toBe(false);
    expect(onSlowStart).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(5);
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

  it("treats an Already onboarded retry response as recoverable", async () => {
    const { isRecoverableOnboardCompletionError } = await loadWelcomeHook();
    expect(
      isRecoverableOnboardCompletionError(new Error("Already onboarded")),
    ).toBe(true);
  });

  it("keeps the recovery poll longer than the setup-to-runtime swap window", async () => {
    const {
      kOnboardCompletionPollAttempts,
      kOnboardCompletionPollIntervalMs,
    } = await loadWelcomeHook();
    // The service swap after onboarding leaves ~55s where the proxy answers
    // 502; a poll that gives up sooner strands the user on an unwinnable
    // retry loop (observed live on 0.9.18-starfoundry.17).
    const kObservedSwapDarkWindowMs = 55000;
    expect(
      kOnboardCompletionPollAttempts * kOnboardCompletionPollIntervalMs,
    ).toBeGreaterThanOrEqual(kObservedSwapDarkWindowMs * 2);
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
