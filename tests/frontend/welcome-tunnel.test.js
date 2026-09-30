const loadWelcomeConfig = async () =>
  import("../../lib/public/js/components/onboarding/welcome-config.js");
const loadWelcomeHook = async () =>
  import("../../lib/public/js/components/welcome/use-welcome.js");

describe("frontend/welcome in Cloudflare Tunnel mode", () => {
  it("drops the Tailscale step only for tunnel instances", async () => {
    const { getWelcomeGroups } = await loadWelcomeConfig();

    expect(getWelcomeGroups({ ingressMode: "cloudflare_tunnel" }).map((g) => g.id)).toEqual([
      "ai",
    ]);
    expect(getWelcomeGroups({ ingressMode: "tailscale" }).map((g) => g.id)).toEqual([
      "ai",
      "tailscale",
    ]);
    expect(getWelcomeGroups().map((g) => g.id)).toEqual(["ai", "tailscale"]);
  });

  it("does not require a Tailscale token when the step is absent", async () => {
    const { findFirstInvalidWelcomeGroup, getWelcomeGroups } =
      await loadWelcomeConfig();
    const vals = { MODEL_KEY: "openai/gpt-5.5", OPENAI_API_KEY: "sk" };
    const ctx = { hasAi: true, selectedProvider: "openai", tailscaleApiToken: "" };

    expect(
      findFirstInvalidWelcomeGroup(
        vals,
        ctx,
        getWelcomeGroups({ ingressMode: "cloudflare_tunnel" }),
      ),
    ).toBeNull();
    expect(findFirstInvalidWelcomeGroup(vals, ctx)?.id).toBe("tailscale");
  });

  it("completes on the fixed dashboard origin, bare so Chat is the landing", async () => {
    const { getTunnelCompletionUrl } = await loadWelcomeHook();

    expect(
      getTunnelCompletionUrl(
        { setupUrl: "https://abc123def456.teamyou.io" },
        "https://abc123def456.teamyou.io",
      ),
    ).toBe("https://abc123def456.teamyou.io/");
    expect(
      getTunnelCompletionUrl({ onboarded: true }, "https://abc123def456.teamyou.io"),
    ).toBe("https://abc123def456.teamyou.io/");
  });
});
