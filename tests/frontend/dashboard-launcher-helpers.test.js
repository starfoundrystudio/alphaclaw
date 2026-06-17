const loadHelpers = async () =>
  import("../../lib/public/js/hooks/dashboard-launcher-helpers.js");

describe("frontend/dashboard-launcher-helpers", () => {
  it("recognizes OpenClaw browser control UI pairing requests", async () => {
    const {
      getDashboardBrowserPairings,
      getPrimaryDashboardPairing,
      isDashboardBrowserPairing,
    } = await loadHelpers();

    const browserRequest = {
      id: "browser-1",
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
    };
    const cliRequest = {
      id: "cli-1",
      clientId: "cli",
      clientMode: "cli",
    };

    expect(isDashboardBrowserPairing(browserRequest)).toBe(true);
    expect(isDashboardBrowserPairing(cliRequest)).toBe(false);
    expect(getDashboardBrowserPairings([cliRequest, browserRequest])).toEqual([
      browserRequest,
    ]);
    expect(getPrimaryDashboardPairing([cliRequest, browserRequest])).toBe(
      browserRequest,
    );
  });

  it("maps dashboard URL payloads to launcher states", async () => {
    const { getDashboardUrlState, kDashboardLauncherStatuses } =
      await loadHelpers();

    expect(
      getDashboardUrlState({
        ok: true,
        url: "/openclaw#token=test",
        source: "config",
      }),
    ).toEqual({
      status: kDashboardLauncherStatuses.READY,
      url: "/openclaw#token=test",
    });

    expect(
      getDashboardUrlState({
        ok: true,
        url: "/openclaw",
        needsAuth: true,
      }),
    ).toEqual({
      status: kDashboardLauncherStatuses.TOKEN_MISSING,
      url: "/openclaw",
    });
  });

  it("times out only after the waiting window expires", async () => {
    const { hasDashboardPairingTimedOut, kDashboardLauncherStatuses } =
      await loadHelpers();

    expect(
      hasDashboardPairingTimedOut({
        status: kDashboardLauncherStatuses.WAITING,
        startedAtMs: 1000,
        nowMs: 2000,
        timeoutMs: 3000,
      }),
    ).toBe(false);

    expect(
      hasDashboardPairingTimedOut({
        status: kDashboardLauncherStatuses.WAITING,
        startedAtMs: 1000,
        nowMs: 4000,
        timeoutMs: 3000,
      }),
    ).toBe(true);

    expect(
      hasDashboardPairingTimedOut({
        status: kDashboardLauncherStatuses.REQUEST,
        startedAtMs: 1000,
        nowMs: 5000,
        timeoutMs: 3000,
      }),
    ).toBe(false);
  });
});
