const loadWelcomeHook = async () =>
  import("../../lib/public/js/components/welcome/use-welcome.js");

describe("frontend/welcome handoff", () => {
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
});
