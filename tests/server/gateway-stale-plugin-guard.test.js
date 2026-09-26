const {
  createGatewayStalePluginGuard,
  isStalePluginInstanceError,
} = require("../../lib/server/gateway-stale-plugin-guard");

const kStaleMessage =
  "PluginInstanceUnavailableError: Plugin vercel-ai-gateway was reloaded or disabled; use its current tools.";

const createHarness = ({ probeResults = [], busy = () => false } = {}) => {
  let nowMs = 1_000_000;
  const timers = [];
  const probe = vi.fn(async () => {
    const next = probeResults.length ? probeResults.shift() : "ok";
    if (next !== "ok") throw new Error(next);
  });
  const restartGateway = vi.fn(async () => {});
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const guard = createGatewayStalePluginGuard({
    probe,
    restartGateway,
    isBusy: busy,
    logger,
    now: () => nowMs,
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs };
      timers.push(timer);
      return timer;
    },
  });
  const runNextTimer = async () => {
    const timer = timers.shift();
    if (!timer) return null;
    nowMs += timer.delayMs;
    timer.fn();
    // Let the async check settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    return timer;
  };
  return {
    guard,
    probe,
    restartGateway,
    logger,
    timers,
    runNextTimer,
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

describe("server/gateway-stale-plugin-guard", () => {
  it("recognizes only the revoked-plugin-instance error", () => {
    expect(isStalePluginInstanceError(new Error(kStaleMessage))).toBe(true);
    expect(
      isStalePluginInstanceError("Plugin memory-core was reloaded or disabled; use its current tools."),
    ).toBe(true);
    expect(isStalePluginInstanceError(new Error("gateway starting"))).toBe(false);
  });

  it("does nothing after a reload that left the Gateway healthy", async () => {
    const h = createHarness({ probeResults: ["ok"] });
    h.guard.afterPluginReload();
    expect(h.timers[0].delayMs).toBe(20000);
    await h.runNextTimer();
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("restarts once when the reloaded Gateway serves a revoked plugin", async () => {
    const h = createHarness({ probeResults: [kStaleMessage] });
    h.guard.afterPluginReload();
    await h.runNextTimer();
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(h.logger.log).toHaveBeenCalledWith(
      expect.stringContaining("restarting it to recover"),
    );
  });

  it("waits for browser chat runs to finish, but not forever", async () => {
    let busy = true;
    const h = createHarness({
      probeResults: [kStaleMessage, kStaleMessage, kStaleMessage],
      busy: () => busy,
    });
    await expect(h.guard.check()).resolves.toEqual({ status: "waiting_for_quiet" });
    expect(h.timers[0].delayMs).toBe(15000);
    await h.runNextTimer();
    expect(h.restartGateway).not.toHaveBeenCalled();
    busy = false;
    await h.runNextTimer();
    expect(h.restartGateway).toHaveBeenCalledTimes(1);

    // Still busy past the two-minute cap: restart anyway.
    const h2 = createHarness({
      probeResults: Array(20).fill(kStaleMessage),
      busy: () => true,
    });
    await h2.guard.check();
    for (let i = 0; i < 10 && !h2.restartGateway.mock.calls.length; i += 1) {
      await h2.runNextTimer();
    }
    expect(h2.restartGateway).toHaveBeenCalledTimes(1);
  });

  it("restarts at most once per interval and ignores its own probe failures", async () => {
    const h = createHarness({ probeResults: Array(5).fill(kStaleMessage) });
    h.guard.reportGatewayError(new Error(kStaleMessage));
    await h.runNextTimer();
    expect(h.restartGateway).toHaveBeenCalledTimes(1);

    // Inside the 10-minute window: reports are ignored, a direct check
    // declines to restart.
    h.advance(60_000);
    h.guard.reportGatewayError(new Error(kStaleMessage));
    expect(h.timers).toHaveLength(0);
    await expect(h.guard.check()).resolves.toEqual({ status: "rate_limited" });
    expect(h.restartGateway).toHaveBeenCalledTimes(1);

    // After the window a new report restarts again.
    h.advance(10 * 60_000);
    h.guard.reportGatewayError(new Error(kStaleMessage));
    await h.runNextTimer();
    expect(h.restartGateway).toHaveBeenCalledTimes(2);
  });

  it("ignores other Gateway errors", async () => {
    const h = createHarness({ probeResults: ["gateway starting"] });
    h.guard.reportGatewayError(new Error("timed out"));
    expect(h.timers).toHaveLength(0);
    await expect(h.guard.check()).resolves.toEqual({ status: "other_error" });
    expect(h.restartGateway).not.toHaveBeenCalled();
  });
});
