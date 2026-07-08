const { createWorkspaceSnapshotManager } = require("../../lib/server/doctor/workspace-snapshot-manager");

describe("server/doctor/workspace-snapshot-manager", () => {
  it("single-flights concurrent refreshes", async () => {
    let resolveSnapshot = null;
    const computeSnapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const manager = createWorkspaceSnapshotManager({
      workspaceRoot: "/tmp/workspace",
      useWorker: false,
      computeSnapshot,
    });

    const firstRefresh = manager.refresh({ force: true });
    const secondRefresh = manager.refresh({ force: true });
    await Promise.resolve();

    expect(computeSnapshot).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().refreshing).toBe(true);

    resolveSnapshot({
      fingerprint: "snapshot-1",
      manifest: {},
      scan: { fileCount: 0 },
    });

    await expect(firstRefresh).resolves.toEqual(
      expect.objectContaining({ fingerprint: "snapshot-1" }),
    );
    await expect(secondRefresh).resolves.toEqual(
      expect.objectContaining({ fingerprint: "snapshot-1" }),
    );
    expect(manager.getStatus().refreshing).toBe(false);
  });

  it("serves a fresh cached snapshot without recomputing", async () => {
    const computeSnapshot = vi.fn(() => ({
      fingerprint: "snapshot-1",
      manifest: {},
      scan: { fileCount: 0 },
    }));
    const manager = createWorkspaceSnapshotManager({
      workspaceRoot: "/tmp/workspace",
      useWorker: false,
      computeSnapshot,
      cacheTtlMs: 60000,
    });

    const firstSnapshot = await manager.refresh({ force: true });
    const cachedSnapshot = await manager.refresh();

    expect(firstSnapshot).toBe(cachedSnapshot);
    expect(computeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("queues a forced refresh behind an in-flight background refresh", async () => {
    const pendingSnapshots = [];
    const computeSnapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingSnapshots.push(resolve);
        }),
    );
    const manager = createWorkspaceSnapshotManager({
      workspaceRoot: "/tmp/workspace",
      useWorker: false,
      computeSnapshot,
      cacheTtlMs: 60000,
    });

    const backgroundRefresh = manager.refresh();
    await Promise.resolve();
    const forcedRefresh = manager.refresh({ force: true });
    await Promise.resolve();

    expect(computeSnapshot).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().refreshing).toBe(true);

    pendingSnapshots[0]({
      fingerprint: "background-snapshot",
      manifest: {},
      scan: { fileCount: 0 },
    });
    await backgroundRefresh;
    await new Promise((resolve) => setImmediate(resolve));

    expect(computeSnapshot).toHaveBeenCalledTimes(2);

    pendingSnapshots[1]({
      fingerprint: "forced-snapshot",
      manifest: {},
      scan: { fileCount: 1 },
    });

    await expect(forcedRefresh).resolves.toEqual(
      expect.objectContaining({ fingerprint: "forced-snapshot" }),
    );
    expect(manager.getSnapshot()).toEqual(
      expect.objectContaining({ fingerprint: "forced-snapshot" }),
    );
    expect(manager.getStatus().refreshing).toBe(false);
  });
});
