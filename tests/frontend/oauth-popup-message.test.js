const loadOauthPopupMessage = async () =>
  import("../../lib/public/js/lib/oauth-popup-message.js");

describe("frontend/oauth-popup-message", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reduces configured URLs to their origin", async () => {
    const mod = await loadOauthPopupMessage();

    expect(mod.getUrlOrigin(" https://callbacks.example.com/base/ ")).toBe(
      "https://callbacks.example.com",
    );
    expect(mod.getUrlOrigin("https://host.ts.net:8443")).toBe(
      "https://host.ts.net:8443",
    );
    expect(mod.getUrlOrigin("")).toBe("");
    expect(mod.getUrlOrigin("not a url")).toBe("");
    expect(mod.getUrlOrigin("data:text/html,hi")).toBe("");
  });

  it("requires both a known popup source and an allowed origin", async () => {
    const mod = await loadOauthPopupMessage();
    const popup = {};
    const options = {
      popups: [popup],
      allowedOrigins: ["https://dash.example"],
    };

    expect(
      mod.isTrustedPopupMessage(
        { origin: "https://dash.example", source: popup },
        options,
      ),
    ).toBe(true);
    expect(
      mod.isTrustedPopupMessage(
        { origin: "https://attacker.example", source: popup },
        options,
      ),
    ).toBe(false);
    expect(
      mod.isTrustedPopupMessage(
        { origin: "https://dash.example", source: {} },
        options,
      ),
    ).toBe(false);
    expect(
      mod.isTrustedPopupMessage(
        { origin: "https://dash.example", source: null },
        { popups: [null], allowedOrigins: ["https://dash.example"] },
      ),
    ).toBe(false);
  });

  it("never matches opaque or empty origins", async () => {
    const mod = await loadOauthPopupMessage();
    const popup = {};

    expect(
      mod.isTrustedPopupMessage(
        { origin: "null", source: popup },
        { popups: [popup], allowedOrigins: ["null", ""] },
      ),
    ).toBe(false);
    expect(
      mod.isTrustedPopupMessage(
        { origin: "", source: popup },
        { popups: [popup], allowedOrigins: [""] },
      ),
    ).toBe(false);
  });
});
