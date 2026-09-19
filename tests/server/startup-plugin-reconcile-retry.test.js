const {
  createStartupPluginReconcileRetry,
  hasPluginChanges,
} = require("../../lib/server/startup-plugin-reconcile-retry");

const quietLogger = { log: vi.fn(), error: vi.fn() };

describe("server/startup-plugin-reconcile-retry", () => {
  it("does nothing when the startup pass succeeded", async () => {
    const reconcile = vi.fn();
    const retry = createStartupPluginReconcileRetry({
      failedAtStartup: false,
      reconcile,
      restartGateway: vi.fn(),
      wait: vi.fn(),
      logger: quietLogger,
    });
    await expect(retry.start()).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "startup_ok",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("retries on a backoff until reconciliation succeeds and reloads the Gateway when it installed something", async () => {
    const waits = [];
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("npm view failed"), {
          stderr: "npm error code E407",
        }),
      )
      .mockRejectedValueOnce(new Error("integrity unknown"))
      .mockResolvedValueOnce({
        plugins: [
          { id: "llama-cpp", action: "skipped" },
          { id: "vercel-ai-gateway", action: "installed" },
        ],
      });
    const restartGateway = vi.fn().mockResolvedValue(undefined);
    const retry = createStartupPluginReconcileRetry({
      failedAtStartup: true,
      isOnboarded: () => true,
      reconcile,
      restartGateway,
      delaysMs: [1, 2, 3, 4],
      wait: async (ms) => {
        waits.push(ms);
      },
      logger: quietLogger,
    });

    await expect(retry.start()).resolves.toEqual({
      ok: true,
      attempt: 3,
      changed: true,
      restarted: true,
    });
    expect(waits).toEqual([1, 2, 3]);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    // start() is idempotent: a second caller gets the same run.
    expect(await retry.start()).toEqual({
      ok: true,
      attempt: 3,
      changed: true,
      restarted: true,
    });
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it("does not reload the Gateway when the retry had nothing to install", async () => {
    const restartGateway = vi.fn();
    const retry = createStartupPluginReconcileRetry({
      failedAtStartup: true,
      reconcile: vi
        .fn()
        .mockResolvedValue({ plugins: [{ id: "x", action: "skipped" }] }),
      restartGateway,
      delaysMs: [1],
      wait: vi.fn(),
      logger: quietLogger,
    });
    await expect(retry.start()).resolves.toEqual({
      ok: true,
      attempt: 1,
      changed: false,
      restarted: false,
    });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("gives up after the last delay and says so", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const retry = createStartupPluginReconcileRetry({
      failedAtStartup: true,
      reconcile: vi.fn().mockRejectedValue(new Error("still 407")),
      restartGateway: vi.fn(),
      delaysMs: [1, 1],
      wait: vi.fn(),
      logger,
    });
    await expect(retry.start()).resolves.toEqual({ ok: false, attempts: 2 });
    expect(logger.error.mock.calls.at(-1)[0]).toMatch(
      /still failing after retries/,
    );
  });

  it("skips when the instance is not onboarded", async () => {
    const reconcile = vi.fn();
    const retry = createStartupPluginReconcileRetry({
      failedAtStartup: true,
      isOnboarded: () => false,
      reconcile,
      wait: vi.fn(),
      logger: quietLogger,
    });
    await expect(retry.start()).resolves.toMatchObject({
      skipped: true,
      reason: "not_onboarded",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("recognises installs and updates as changes", () => {
    expect(hasPluginChanges({ plugins: [{ action: "updated" }] })).toBe(true);
    expect(
      hasPluginChanges({
        plugins: [{ action: "skipped" }, { action: "unset" }],
      }),
    ).toBe(false);
    expect(hasPluginChanges(null)).toBe(false);
  });
});
