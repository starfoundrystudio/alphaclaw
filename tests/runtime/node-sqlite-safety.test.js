const {
  assertSafeNodeSqliteRuntime,
  isSqliteWalResetSafeVersion,
  isSupportedOpenclawNodeVersion,
} = require("../../lib/runtime/node-sqlite-safety");

const createSqliteModule = (version) => ({
  DatabaseSync: class {
    prepare() {
      return { get: () => ({ version }) };
    }

    close() {}
  },
});

describe("Node and SQLite runtime safety", () => {
  it.each([
    ["22.22.3", true],
    ["22.22.2", false],
    ["23.11.1", false],
    ["24.15.0", true],
    ["24.14.9", false],
    ["25.9.0", true],
    ["26.0.0", true],
  ])("evaluates OpenClaw Node support for %s", (version, expected) => {
    expect(isSupportedOpenclawNodeVersion(version)).toBe(expected);
  });

  it.each([
    ["3.44.5", false],
    ["3.44.6", true],
    ["3.45.0", false],
    ["3.50.6", false],
    ["3.50.7", true],
    ["3.51.2", false],
    ["3.51.3", true],
    ["3.53.0", true],
  ])("evaluates SQLite WAL safety for %s", (version, expected) => {
    expect(isSqliteWalResetSafeVersion(version)).toBe(expected);
  });

  it("rejects unsupported Node before opening SQLite", () => {
    const DatabaseSync = vi.fn();
    expect(() =>
      assertSafeNodeSqliteRuntime({
        nodeVersion: "22.22.2",
        sqliteModule: { DatabaseSync },
      }),
    ).toThrow("found Node 22.22.2");
    expect(DatabaseSync).not.toHaveBeenCalled();
  });

  it("rejects an unsafe loaded SQLite library", () => {
    expect(() =>
      assertSafeNodeSqliteRuntime({
        nodeVersion: "24.15.0",
        sqliteModule: createSqliteModule("3.51.2"),
      }),
    ).toThrow("loaded SQLite 3.51.2");
  });

  it("accepts a supported Node and loaded SQLite library", () => {
    expect(
      assertSafeNodeSqliteRuntime({
        nodeVersion: "24.15.0",
        sqliteModule: createSqliteModule("3.51.3"),
      }),
    ).toBeTruthy();
  });
});
