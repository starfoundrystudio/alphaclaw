const {
  createGatewayBootPreparation,
} = require("../../lib/server/gateway-boot-preparation");

describe("gateway first-boot preparation", () => {
  it("holds one launch behind enrollment and applies config changes before spawning", async () => {
    let release;
    const enrollment = new Promise((resolve) => {
      release = resolve;
    });
    const start = vi.fn();
    const prepare = vi.fn(() => enrollment);
    const boot = createGatewayBootPreparation({ prepare, start });
    const first = boot.start();
    const second = boot.start();
    expect(first).toBe(second);
    expect(boot.hasStarted()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    release({ ready: true });
    await first;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(boot.hasStarted()).toBe(true);
  });

  it("retries pending or failed enrollment without exposing a half-configured gateway", async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValue({ ready: true });
    const start = vi.fn();
    const wait = vi.fn(async () => {
      expect(start).not.toHaveBeenCalled();
    });
    const boot = createGatewayBootPreparation({
      prepare,
      start,
      wait,
      logger: { log: vi.fn() },
    });
    await boot.start();
    expect(wait).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
