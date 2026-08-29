import { getGoogleDisconnectOutcome } from "../../lib/public/js/components/google/disconnect-outcome.js";

describe("Google disconnect outcome", () => {
  it("refreshes with a warning when local cleanup succeeded and revocation is pending", () => {
    expect(
      getGoogleDisconnectOutcome({
        ok: false,
        localDisconnected: true,
        revocationPending: true,
        error: "ssh_failed",
      }),
    ).toEqual({
      refresh: true,
      tone: "warning",
      message:
        "Google account disconnected locally; gateway revocation will retry automatically",
    });
  });

  it("keeps a genuine local cleanup failure visible", () => {
    expect(
      getGoogleDisconnectOutcome({
        ok: false,
        localDisconnected: false,
        revocationPending: true,
        error: "permission_denied",
      }),
    ).toEqual({
      refresh: false,
      tone: "error",
      message: "Failed to disconnect: permission_denied",
    });
  });

  it("refreshes normally after complete revocation", () => {
    expect(getGoogleDisconnectOutcome({ ok: true })).toEqual({
      refresh: true,
      tone: "success",
      message: "Google account disconnected",
    });
  });
});
