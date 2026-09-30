const loadGoogleOauthWindow = async () =>
  import("../../lib/public/js/lib/google-oauth-window.js");

const kDashboardOrigin = "https://dash.example.ts.net";
const kPublicCallbackBaseUrl = "https://callbacks.example.com/";

describe("frontend/google-oauth-window", () => {
  beforeEach(() => {
    vi.resetModules();
    global.window = {
      open: vi.fn(),
      location: { href: `${kDashboardOrigin}/`, origin: kDashboardOrigin },
    };
  });

  it("opens a per-account popup", async () => {
    const popup = { closed: false };
    global.window.open.mockReturnValue(popup);
    const mod = await loadGoogleOauthWindow();

    const opened = mod.openGoogleAuthWindow("/auth/google/start?x=1", "acct-1");

    expect(global.window.open).toHaveBeenCalledWith(
      "/auth/google/start?x=1",
      "google-auth-acct-1",
      "popup=yes,width=500,height=700",
    );
    expect(opened).toBe(popup);
  });

  it("returns null when the popup is blocked", async () => {
    global.window.open.mockReturnValue({ closed: true });
    const mod = await loadGoogleOauthWindow();

    expect(mod.openGoogleAuthWindow("/auth/google/start", "acct-1")).toBeNull();
  });

  it("accepts results from its popup on the dashboard or public callback origin", async () => {
    const popup = { closed: false };
    global.window.open.mockReturnValue(popup);
    const mod = await loadGoogleOauthWindow();
    mod.openGoogleAuthWindow("/auth/google/start", "acct-1");
    const data = { google: "success", accountId: "acct-1" };
    const options = { publicCallbackBaseUrl: kPublicCallbackBaseUrl };

    expect(
      mod.isGoogleAuthPopupMessage(
        { data, origin: kDashboardOrigin, source: popup },
        options,
      ),
    ).toBe(true);
    expect(
      mod.isGoogleAuthPopupMessage(
        { data, origin: "https://callbacks.example.com", source: popup },
        options,
      ),
    ).toBe(true);
    expect(
      mod.isGoogleAuthPopupMessage(
        { data, origin: "https://callbacks.example.com", source: popup },
        {},
      ),
    ).toBe(false);
  });

  it("rejects messages from other origins or windows", async () => {
    const popup = { closed: false };
    global.window.open.mockReturnValue(popup);
    const mod = await loadGoogleOauthWindow();
    mod.openGoogleAuthWindow("/auth/google/start", "acct-1");
    const data = { google: "success", accountId: "acct-1" };
    const options = { publicCallbackBaseUrl: kPublicCallbackBaseUrl };

    expect(
      mod.isGoogleAuthPopupMessage(
        { data, origin: "https://attacker.example", source: popup },
        options,
      ),
    ).toBe(false);
    expect(
      mod.isGoogleAuthPopupMessage(
        { data, origin: kDashboardOrigin, source: { closed: false } },
        options,
      ),
    ).toBe(false);
  });

  it("keeps accepting an earlier account popup while it stays open", async () => {
    const first = { closed: false };
    const second = { closed: false };
    global.window.open.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const mod = await loadGoogleOauthWindow();
    mod.openGoogleAuthWindow("/auth/google/start", "acct-1");
    mod.openGoogleAuthWindow("/auth/google/start", "acct-2");
    const message = (source) => ({
      data: { google: "success" },
      origin: kDashboardOrigin,
      source,
    });

    expect(mod.isGoogleAuthPopupMessage(message(first))).toBe(true);
    expect(mod.isGoogleAuthPopupMessage(message(second))).toBe(true);
  });
});
