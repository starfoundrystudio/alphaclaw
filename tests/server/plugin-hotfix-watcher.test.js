const { createPluginHotfixWatcher } = require("../../lib/server/plugin-hotfix-watcher");

// G3 finding #27: the Gateway hot-loaded @openclaw/slack a few seconds before
// the hotfix patched it, so Slack's first start ran unpatched code.
const kNow = Date.parse("2026-09-22T22:30:00Z");
const createWatcher = ({ mtimeMs, gatewayStartedAtMs, busy = false, status = "applied" }) => {
  const restartGateway = vi.fn(async () => {});
  const logger = { log: vi.fn(), warn: vi.fn() };
  const watcher = createPluginHotfixWatcher({
    openclawDir: "/state/.openclaw",
    getGatewayStartedAtMs: () => gatewayStartedAtMs,
    isGatewayLifecycleBusy: () => busy,
    restartGateway,
    now: () => kNow,
    logger,
    fsModule: { statSync: () => ({ mtimeMs }) },
    applyHotfixes: () => [
      {
        id: "slack-socket-mode-proxy-dispatcher",
        status,
        patchedFiles: ["/state/.openclaw/npm/projects/slack/provider.mjs"],
      },
    ],
  });
  return { watcher, restartGateway, logger };
};

describe("server/plugin-hotfix-watcher", () => {
  it("restarts a Gateway that loaded the plugin before it was patched", async () => {
    const { watcher, restartGateway, logger } = createWatcher({
      gatewayStartedAtMs: kNow - 30 * 60 * 1000,
      mtimeMs: kNow - 3 * 60 * 1000,
      status: "already-applied",
    });
    await expect(watcher.check()).resolves.toMatchObject({ restarted: true });
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("slack-socket-mode-proxy-dispatcher"),
    );
  });

  it("waits out the grace period so flows that restart anyway are not doubled", async () => {
    const { watcher, restartGateway } = createWatcher({
      gatewayStartedAtMs: kNow - 30 * 60 * 1000,
      mtimeMs: kNow - 30 * 1000,
    });
    await watcher.check();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("leaves a Gateway alone when it started after the patch", async () => {
    const { watcher, restartGateway } = createWatcher({
      gatewayStartedAtMs: kNow - 60 * 1000,
      mtimeMs: kNow - 10 * 60 * 1000,
    });
    await watcher.check();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("defers while another lifecycle operation owns the Gateway", async () => {
    const { watcher, restartGateway } = createWatcher({
      gatewayStartedAtMs: kNow - 30 * 60 * 1000,
      mtimeMs: kNow - 3 * 60 * 1000,
      busy: true,
    });
    await expect(watcher.check()).resolves.toMatchObject({ deferred: true });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("does nothing while no managed Gateway is running", async () => {
    const { watcher, restartGateway } = createWatcher({
      gatewayStartedAtMs: 0,
      mtimeMs: kNow - 3 * 60 * 1000,
    });
    await watcher.check();
    expect(restartGateway).not.toHaveBeenCalled();
  });
});
