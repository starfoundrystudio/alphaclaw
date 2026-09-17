const path = require("path");
const {
  kGatewayHopState,
  readGatewayHopProbe,
  refreshGatewayHopSnapshot,
} = require("../../lib/server/gateway-hop-probe");

const fixture = (name) =>
  path.join(__dirname, "fixtures", "gateway-hop-probe", name);

/** Thirty seconds after the healthy/failing fixtures were written. */
const kNow = Date.parse("2026-09-15T21:20:41Z");
const kStaleMs = 6 * 60 * 1000;

const read = (name, overrides = {}) =>
  readGatewayHopProbe({ filePath: fixture(name), now: kNow, staleMs: kStaleMs, ...overrides });

describe("server/gateway-hop-probe", () => {
  it("reports a fresh successful probe as healthy", () => {
    const snapshot = read("healthy.json");
    expect(snapshot).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.healthy,
        available: true,
        ok: true,
        configured: true,
        gatewayHost: "10.162.2.3",
        checkedAt: "2026-09-15T21:20:11.000Z",
        checkedAgeMs: 30 * 1000,
        lastOkAt: "2026-09-15T21:20:11.000Z",
        consecutiveFailures: 0,
        error: null,
        detail: null,
        stale: false,
        reason: null,
        staleAfterMs: kStaleMs,
      }),
    );
    expect(snapshot.path).toBe(fixture("healthy.json"));
  });

  it("reports a failed probe with its error, detail and failure count", () => {
    expect(read("failing.json")).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.failing,
        ok: false,
        configured: true,
        gatewayHost: "10.162.2.3",
        consecutiveFailures: 3,
        error: "ssh_failed",
        detail: "ssh: connect to host 10.162.2.3 port 22: Connection refused",
        lastOkAt: "2026-09-15T21:14:03.000Z",
        stale: false,
      }),
    );
  });

  it("marks a probe older than the stale window as stale instead of healthy", () => {
    const snapshot = read("stale.json");
    expect(snapshot.state).toBe(kGatewayHopState.stale);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.checkedAgeMs).toBe(15 * 60 * 1000 + 41 * 1000);
  });

  it("uses the configured stale window", () => {
    expect(read("stale.json", { staleMs: 60 * 60 * 1000 }).state).toBe(
      kGatewayHopState.healthy,
    );
    expect(read("healthy.json", { staleMs: 10 * 1000 }).state).toBe(
      kGatewayHopState.stale,
    );
  });

  it("treats an unconfigured broker as not applicable, never as a failure", () => {
    const snapshot = read("unconfigured.json");
    expect(snapshot.state).toBe(kGatewayHopState.notApplicable);
    expect(snapshot.configured).toBe(false);
    expect(snapshot.consecutiveFailures).toBe(7);
    expect(snapshot.error).toBe("not_configured");
    expect(snapshot.gatewayHost).toBeNull();
    expect(snapshot.lastOkAt).toBeNull();
  });

  it("keeps not applicable even when the unconfigured probe is stale", () => {
    expect(
      read("unconfigured.json", { now: kNow + 60 * 60 * 1000 }).state,
    ).toBe(kGatewayHopState.notApplicable);
  });

  it("reports a missing file as unavailable", () => {
    const snapshot = read("does-not-exist.json");
    expect(snapshot).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.unavailable,
        available: false,
        reason: "missing",
        ok: null,
        configured: null,
        consecutiveFailures: 0,
      }),
    );
  });

  it("reports other read errors as unreadable", () => {
    const fsModule = {
      readFileSync: () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
    };
    expect(read("healthy.json", { fsModule })).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.unavailable,
        reason: "unreadable",
      }),
    );
  });

  it("rejects truncated JSON", () => {
    expect(read("malformed-truncated.json")).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.invalid,
        available: false,
        reason: "not_json",
      }),
    );
  });

  it("rejects documents whose required fields have the wrong type", () => {
    expect(read("malformed-shape.json")).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.invalid,
        reason: "invalid_shape",
      }),
    );
  });

  it("rejects unsupported schema versions", () => {
    expect(read("unsupported-schema.json")).toEqual(
      expect.objectContaining({
        state: kGatewayHopState.invalid,
        reason: "unsupported_schema",
      }),
    );
  });

  it("rejects non-object documents and oversized files", () => {
    const fsModule = { readFileSync: () => Buffer.from("[1,2,3]") };
    expect(read("healthy.json", { fsModule }).reason).toBe("invalid_shape");
    const oversized = { readFileSync: () => Buffer.alloc(17 * 1024, 0x20) };
    expect(read("healthy.json", { fsModule: oversized }).reason).toBe("too_large");
  });

  it("sanitizes untrusted strings before surfacing them", () => {
    const snapshot = read("hostile-strings.json");
    expect(snapshot.state).toBe(kGatewayHopState.failing);
    expect(snapshot.gatewayHost).toBeNull();
    expect(snapshot.lastOkAt).toBeNull();
    expect(snapshot.error).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    expect(snapshot.error).not.toContain("<");
    expect(snapshot.detail).not.toMatch(/[\u0000-\u001f]/);
    expect(snapshot.detail.length).toBeLessThanOrEqual(500);
    expect(snapshot.detail.startsWith("line one line two")).toBe(true);
  });

  it("drops error and detail from successful probes", () => {
    const fsModule = {
      readFileSync: () =>
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            probe: "oauth_broker_status",
            ok: true,
            configured: true,
            checked_at: "2026-09-15T21:20:11Z",
            error: "leftover",
            detail: "leftover detail",
          }),
        ),
    };
    const snapshot = read("healthy.json", { fsModule });
    expect(snapshot.state).toBe(kGatewayHopState.healthy);
    expect(snapshot.error).toBeNull();
    expect(snapshot.detail).toBeNull();
    expect(snapshot.consecutiveFailures).toBe(0);
  });

  it("falls back to an unknown error code when a failed probe omits it", () => {
    const fsModule = {
      readFileSync: () =>
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            probe: "oauth_broker_status",
            ok: false,
            configured: true,
            checked_at: "2026-09-15T21:20:11Z",
            consecutive_failures: 2,
          }),
        ),
    };
    expect(read("healthy.json", { fsModule }).error).toBe("unknown");
  });

  describe("refreshGatewayHopSnapshot", () => {
    it("recomputes age and staleness for a later clock reading", () => {
      const snapshot = read("healthy.json");
      const later = refreshGatewayHopSnapshot(snapshot, {
        now: kNow + 10 * 60 * 1000,
        staleMs: kStaleMs,
      });
      expect(later.state).toBe(kGatewayHopState.stale);
      expect(later.stale).toBe(true);
      expect(later.checkedAgeMs).toBe(10 * 60 * 1000 + 30 * 1000);
      expect(later.ok).toBe(true);
      expect(snapshot.state).toBe(kGatewayHopState.healthy);
    });

    it("leaves unavailable and invalid snapshots untouched", () => {
      const missing = read("does-not-exist.json");
      expect(
        refreshGatewayHopSnapshot(missing, { now: kNow + 1, staleMs: kStaleMs }),
      ).toEqual(expect.objectContaining({ state: kGatewayHopState.unavailable }));
      const invalid = read("malformed-shape.json");
      expect(
        refreshGatewayHopSnapshot(invalid, { now: kNow + 1, staleMs: kStaleMs }),
      ).toEqual(expect.objectContaining({ state: kGatewayHopState.invalid }));
    });
  });
});
