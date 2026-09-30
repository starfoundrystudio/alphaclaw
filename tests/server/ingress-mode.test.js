const {
  kIngressModeCloudflareTunnel,
  kIngressModeTailscale,
  getIngressMode,
  isCloudflareTunnelMode,
  isConfiguredTunnelOrigin,
  normalizeTunnelOrigin,
  readConfiguredTunnelUrls,
} = require("../../lib/ingress-mode");
const { kSystemVars } = require("../../lib/server/constants");

describe("ingress mode resolver", () => {
  it("defaults to tailscale when unset", () => {
    expect(getIngressMode({ env: {}, envVars: [] })).toBe(kIngressModeTailscale);
    expect(isCloudflareTunnelMode({ env: {} })).toBe(false);
  });

  it("reads the process env first, then .env entries, lowercased", () => {
    expect(
      getIngressMode({ env: { ALPHACLAW_INGRESS_MODE: "Cloudflare_Tunnel" } }),
    ).toBe(kIngressModeCloudflareTunnel);
    expect(
      getIngressMode({
        env: {},
        envVars: [{ key: "ALPHACLAW_INGRESS_MODE", value: "cloudflare_tunnel" }],
      }),
    ).toBe(kIngressModeCloudflareTunnel);
    expect(
      getIngressMode({
        env: { ALPHACLAW_INGRESS_MODE: "tailscale" },
        envVars: [{ key: "ALPHACLAW_INGRESS_MODE", value: "cloudflare_tunnel" }],
      }),
    ).toBe(kIngressModeTailscale);
  });

  it("throws on unknown values", () => {
    expect(() =>
      getIngressMode({ env: { ALPHACLAW_INGRESS_MODE: "ngrok" } }),
    ).toThrow("Unsupported Clawbridge ingress mode: ngrok");
  });

  it("is a system var", () => {
    expect(kSystemVars.has("ALPHACLAW_INGRESS_MODE")).toBe(true);
  });

  it("accepts only bare https origins", () => {
    expect(normalizeTunnelOrigin("https://abc.teamyou.io")).toBe(
      "https://abc.teamyou.io",
    );
    expect(normalizeTunnelOrigin("https://abc.teamyou.io/")).toBe(
      "https://abc.teamyou.io",
    );
    for (const value of [
      "",
      "http://abc.teamyou.io",
      "https://abc.teamyou.io:8443",
      "https://abc.teamyou.io/path",
      "https://abc.teamyou.io/?q=1",
      "https://abc.teamyou.io/#x",
      "https://user@abc.teamyou.io",
      "not a url",
    ]) {
      expect(normalizeTunnelOrigin(value)).toBe("");
    }
  });

  it("matches configured origins exactly, never by suffix", () => {
    expect(
      isConfiguredTunnelOrigin("https://abc.teamyou.io/", "https://abc.teamyou.io"),
    ).toBe(true);
    expect(
      isConfiguredTunnelOrigin("https://evil.abc.teamyou.io", "https://abc.teamyou.io"),
    ).toBe(false);
    expect(
      isConfiguredTunnelOrigin("https://xyz.teamyou.io", "https://abc.teamyou.io"),
    ).toBe(false);
    expect(isConfiguredTunnelOrigin("https://abc.teamyou.io", "")).toBe(false);
  });

  it("reads the three configured tunnel URLs", () => {
    expect(
      readConfiguredTunnelUrls({
        env: { ALPHACLAW_SETUP_URL: "https://a.teamyou.io" },
        envVars: [
          { key: "ALPHACLAW_PUBLIC_BASE_URL", value: "https://a-hooks.teamyou.io" },
          { key: "AGENT_VAULT_OPERATOR_URL", value: "https://a-vault.teamyou.io" },
        ],
      }),
    ).toEqual({
      setupUrl: "https://a.teamyou.io",
      publicBaseUrl: "https://a-hooks.teamyou.io",
      agentVaultOperatorUrl: "https://a-vault.teamyou.io",
    });
  });
});
