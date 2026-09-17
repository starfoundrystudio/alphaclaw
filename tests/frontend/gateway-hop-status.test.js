vi.mock("preact/hooks", () => ({
  useState: (initial) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useEffect: () => {},
  useMemo: (compute) => compute(),
}));

const textOf = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
};

const kNowMs = Date.parse("2026-09-15T21:20:41Z");

const buildHop = (overrides = {}) => ({
  state: "healthy",
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
  staleAfterMs: 6 * 60 * 1000,
  incidentActive: false,
  alarmFailureThreshold: 2,
  ...overrides,
});

describe("security gateway hop status helpers", () => {
  it("hides the indicator when the probe is missing or not applicable", async () => {
    const { describeGatewayHopStatus } = await import(
      "../../lib/public/js/lib/gateway-hop.js"
    );
    expect(describeGatewayHopStatus(null, kNowMs).visible).toBe(false);
    expect(
      describeGatewayHopStatus(
        buildHop({ state: "unavailable", available: false, reason: "missing" }),
        kNowMs,
      ).visible,
    ).toBe(false);
    expect(
      describeGatewayHopStatus(
        buildHop({ state: "not_applicable", configured: false, ok: false }),
        kNowMs,
      ).visible,
    ).toBe(false);
  });

  it("describes a healthy hop with the probe age", async () => {
    const { describeGatewayHopStatus } = await import(
      "../../lib/public/js/lib/gateway-hop.js"
    );
    expect(describeGatewayHopStatus(buildHop(), kNowMs)).toEqual({
      visible: true,
      state: "healthy",
      tone: "healthy",
      label: "reachable",
      detail: "checked 30s ago",
    });
  });

  it("describes a failing hop with error, failure count and tone by threshold", async () => {
    const { describeGatewayHopStatus } = await import(
      "../../lib/public/js/lib/gateway-hop.js"
    );
    const alarm = describeGatewayHopStatus(
      buildHop({
        state: "failing",
        ok: false,
        consecutiveFailures: 3,
        error: "ssh_failed",
        detail: "Connection refused",
      }),
      kNowMs,
    );
    expect(alarm.label).toBe("unreachable");
    expect(alarm.tone).toBe("danger");
    expect(alarm.detail).toBe("ssh_failed · 3 consecutive failures · checked 30s ago");

    const first = describeGatewayHopStatus(
      buildHop({ state: "failing", ok: false, consecutiveFailures: 1, error: "timeout" }),
      kNowMs,
    );
    expect(first.tone).toBe("warning");
    expect(first.detail).toContain("1 consecutive failure ·");
  });

  it("shows stale probes as unknown, including when the client clock makes them stale", async () => {
    const { describeGatewayHopStatus } = await import(
      "../../lib/public/js/lib/gateway-hop.js"
    );
    const stale = describeGatewayHopStatus(
      buildHop({ state: "stale", stale: true, checkedAt: "2026-09-15T21:05:00.000Z" }),
      kNowMs,
    );
    expect(stale).toEqual(
      expect.objectContaining({ visible: true, tone: "unknown", label: "unknown" }),
    );
    expect(stale.detail).toBe("last probe 15m ago");

    const agedOut = describeGatewayHopStatus(buildHop(), kNowMs + 20 * 60 * 1000);
    expect(agedOut.state).toBe("stale");
    expect(agedOut.label).toBe("unknown");
  });

  it("flags invalid probe data", async () => {
    const { describeGatewayHopStatus } = await import(
      "../../lib/public/js/lib/gateway-hop.js"
    );
    expect(
      describeGatewayHopStatus(
        buildHop({ state: "invalid", available: false, reason: "not_json" }),
        kNowMs,
      ),
    ).toEqual(
      expect.objectContaining({
        visible: true,
        tone: "unknown",
        label: "probe data invalid",
        detail: "not_json",
      }),
    );
  });

  it("formats relative ages", async () => {
    const { formatRelativeAge } = await import("../../lib/public/js/lib/gateway-hop.js");
    expect(formatRelativeAge(2000)).toBe("just now");
    expect(formatRelativeAge(45 * 1000)).toBe("45s ago");
    expect(formatRelativeAge(9 * 60 * 1000)).toBe("9m ago");
    expect(formatRelativeAge(3 * 60 * 60 * 1000)).toBe("3h ago");
    expect(formatRelativeAge(3 * 24 * 60 * 60 * 1000)).toBe("3d ago");
    expect(formatRelativeAge(null)).toBe("unknown");
  });
});

describe("General gateway card security gateway row", () => {
  it("renders the row for a failing hop and hides it when not applicable", async () => {
    const { Gateway } = await import("../../lib/public/js/components/gateway.js");
    const failing = textOf(
      Gateway({
        status: "running",
        watchdogStatus: {
          health: "healthy",
          gatewayHop: buildHop({
            state: "failing",
            ok: false,
            consecutiveFailures: 3,
            error: "ssh_failed",
            checkedAt: new Date(Date.now() - 30 * 1000).toISOString(),
          }),
        },
      }),
    );
    expect(failing).toContain("Security gateway:");
    expect(failing).toContain("unreachable");
    expect(failing).toContain("ssh_failed");

    const hidden = textOf(
      Gateway({
        status: "running",
        watchdogStatus: {
          health: "healthy",
          gatewayHop: buildHop({ state: "not_applicable", configured: false }),
        },
      }),
    );
    expect(hidden).not.toContain("Security gateway:");
    expect(textOf(Gateway({ status: "running", watchdogStatus: { health: "healthy" } }))).not.toContain(
      "Security gateway:",
    );
  });
});
