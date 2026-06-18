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

  it("detects an already paired OpenClaw browser from local storage", async () => {
    const {
      kOpenClawDeviceAuthStorageKey,
      kOpenClawDeviceIdentityStorageKey,
      readOpenClawBrowserAuthState,
    } = await loadHelpers();
    const storage = new Map([
      [
        kOpenClawDeviceIdentityStorageKey,
        JSON.stringify({
          version: 1,
          deviceId: "device-1",
          publicKey: "public-key",
          privateKey: "private-key",
        }),
      ],
      [
        kOpenClawDeviceAuthStorageKey,
        JSON.stringify({
          version: 1,
          deviceId: "device-1",
          tokens: {
            operator: {
              token: "operator-token",
              role: "operator",
              scopes: ["operator.read"],
              updatedAtMs: 1000,
            },
          },
        }),
      ],
    ]);

    expect(
      readOpenClawBrowserAuthState({
        getItem: (key) => storage.get(key) || null,
      }),
    ).toEqual({
      deviceId: "device-1",
      hasOperatorToken: true,
      scopes: ["operator.read"],
    });
  });

  it("does not treat mismatched or unreadable OpenClaw browser auth as paired", async () => {
    const {
      kOpenClawDeviceAuthStorageKey,
      kOpenClawDeviceIdentityStorageKey,
      readOpenClawBrowserAuthState,
    } = await loadHelpers();
    const makeStorage = (auth) => {
      const storage = new Map([
        [
          kOpenClawDeviceIdentityStorageKey,
          JSON.stringify({
            version: 1,
            deviceId: "device-1",
            publicKey: "public-key",
            privateKey: "private-key",
          }),
        ],
        [kOpenClawDeviceAuthStorageKey, JSON.stringify(auth)],
      ]);
      return {
        getItem: (key) => storage.get(key) || null,
      };
    };

    expect(
      readOpenClawBrowserAuthState(
        makeStorage({
          version: 1,
          deviceId: "other-device",
          tokens: {
            operator: {
              token: "operator-token",
              scopes: ["operator.read"],
            },
          },
        }),
      ).hasOperatorToken,
    ).toBe(false);

    expect(
      readOpenClawBrowserAuthState(
        makeStorage({
          version: 1,
          deviceId: "device-1",
          tokens: {
            operator: {
              token: "operator-token",
              scopes: ["operator.pairing"],
            },
          },
        }),
      ).hasOperatorToken,
    ).toBe(false);
  });
});
