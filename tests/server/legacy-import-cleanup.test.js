const os = require("os");
const path = require("path");
const {
  kLegacyImportTempTtlMs,
  cleanupLegacyImportTempDirs,
} = require("../../lib/server/legacy-import-cleanup");

describe("server/legacy-import-cleanup", () => {
  it("removes only stale temp directories left by discontinued imports", () => {
    const tempRoot = path.resolve(os.tmpdir());
    const stalePath = path.join(tempRoot, "alphaclaw-import-stale");
    const freshPath = path.join(tempRoot, "alphaclaw-import-fresh");
    const unrelatedPath = path.join(tempRoot, "unrelated-stale");
    const entries = [
      { name: path.basename(stalePath), isDirectory: () => true },
      { name: path.basename(freshPath), isDirectory: () => true },
      { name: path.basename(unrelatedPath), isDirectory: () => true },
    ];
    const fsModule = {
      readdirSync: vi.fn(() => entries),
      statSync: vi.fn((candidate) => ({
        mtimeMs: candidate === freshPath ? kLegacyImportTempTtlMs : 0,
      })),
      rmSync: vi.fn(),
    };

    expect(cleanupLegacyImportTempDirs({
      fsModule,
      nowMs: kLegacyImportTempTtlMs + 1,
    })).toEqual({ removedCount: 1 });
    expect(fsModule.rmSync).toHaveBeenCalledWith(stalePath, {
      recursive: true,
      force: true,
    });
    expect(fsModule.rmSync).not.toHaveBeenCalledWith(freshPath, expect.anything());
    expect(fsModule.statSync).not.toHaveBeenCalledWith(unrelatedPath);
  });
});
