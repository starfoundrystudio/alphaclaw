const {
  hasBootstrapHandoffStatus,
} = require("../../lib/server/onboarding/gateway-tailscale-finalizer");

describe("gateway Tailscale finalizer handoff capability", () => {
  it("advertises bootstrap-origin handoff only for matching gateway bundles", () => {
    expect(
      hasBootstrapHandoffStatus({
        env: { ALPHACLAW_BOOTSTRAP_HANDOFF_STATUS: "true" },
      }),
    ).toBe(true);
    expect(
      hasBootstrapHandoffStatus({
        env: { ALPHACLAW_BOOTSTRAP_HANDOFF_STATUS: "false" },
      }),
    ).toBe(false);
    expect(hasBootstrapHandoffStatus({ env: {} })).toBe(false);
  });
});
