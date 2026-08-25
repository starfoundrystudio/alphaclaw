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

  it("keeps recurring pairings polling on while an unpaired channel awaits its first DM", async () => {
    const { shouldEnableRecurringPairingsPolling } = await loadGeneralHelpers();

    // Polls even with zero pending requests — a new request arriving from
    // the user's first DM is exactly what the poll exists to discover.
    expect(
      shouldEnableRecurringPairingsPolling({
        isActive: true,
        hasUnpaired: true,
        gatewayStatus: "running",
      }),
    ).toBe(true);
    expect(
      shouldEnableRecurringPairingsPolling({
        isActive: false,
        hasUnpaired: true,
        gatewayStatus: "running",
      }),
    ).toBe(false);
    expect(
      shouldEnableRecurringPairingsPolling({
        isActive: true,
        hasUnpaired: false,
        gatewayStatus: "running",
      }),
    ).toBe(false);
    expect(
      shouldEnableRecurringPairingsPolling({
        isActive: true,
        hasUnpaired: true,
        gatewayStatus: "stopped",
      }),
    ).toBe(false);
  });
});
