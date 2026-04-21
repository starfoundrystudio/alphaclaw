const loadGeneralHelpers = async () =>
  import("../../lib/public/js/components/general/helpers.js");

describe("frontend/general-helpers", () => {
  it("primes a one-shot pairings fetch only when the General tab is active, the gateway is running, and channels are awaiting pairing", async () => {
    const { shouldPrimePairingsFetch } = await loadGeneralHelpers();

    expect(
      shouldPrimePairingsFetch({
        isActive: true,
        hasUnpaired: true,
        gatewayStatus: "running",
      }),
    ).toBe(true);
    expect(
      shouldPrimePairingsFetch({
        isActive: false,
        hasUnpaired: true,
        gatewayStatus: "running",
      }),
    ).toBe(false);
    expect(
      shouldPrimePairingsFetch({
        isActive: true,
        hasUnpaired: false,
        gatewayStatus: "running",
      }),
    ).toBe(false);
    expect(
      shouldPrimePairingsFetch({
        isActive: true,
        hasUnpaired: true,
        gatewayStatus: "starting",
      }),
    ).toBe(false);
  });

  it("enables recurring pairings polling only when a prior fetch found real pending requests", async () => {
    const { shouldEnableRecurringPairingsPolling } = await loadGeneralHelpers();

    expect(
      shouldEnableRecurringPairingsPolling({
        hasUnpaired: true,
        gatewayStatus: "running",
        pairingsPollingEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldEnableRecurringPairingsPolling({
        hasUnpaired: true,
        gatewayStatus: "running",
        pairingsPollingEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldEnableRecurringPairingsPolling({
        hasUnpaired: true,
        gatewayStatus: "stopped",
        pairingsPollingEnabled: true,
      }),
    ).toBe(false);
  });

  it("turns recurring pairings polling on only when the latest fetch returns pending requests", async () => {
    const { derivePairingsPollingEnabled } = await loadGeneralHelpers();

    expect(derivePairingsPollingEnabled([])).toBe(false);
    expect(derivePairingsPollingEnabled(null)).toBe(false);
    expect(
      derivePairingsPollingEnabled([
        { id: "req-1", channel: "telegram" },
      ]),
    ).toBe(true);
  });
});
