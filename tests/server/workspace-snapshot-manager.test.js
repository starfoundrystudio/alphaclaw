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
});
