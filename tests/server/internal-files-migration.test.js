const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildManagedPaths,
  migrateManagedInternalFiles,
} = require("../../lib/server/internal-files-migration");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-managed-files-test-"));

describe("server/internal-files-migration", () => {
  it("removes retired GitHub sync artifacts and preserves unrelated gitignore rules", () => {
    const openclawDir = createTempOpenclawDir();
    const systemCronPath = path.join(openclawDir, "openclaw-hourly-sync.cron");
    const managedPaths = buildManagedPaths({ openclawDir });
    const gitignorePath = path.join(openclawDir, ".gitignore");
    fs.mkdirSync(managedPaths.internalDir, { recursive: true });
    fs.mkdirSync(path.dirname(managedPaths.retiredHourlyGitSyncConfigPath), {
      recursive: true,
    });
    for (const retiredPath of [
      managedPaths.retiredHourlyGitSyncPath,
      managedPaths.legacyHourlyGitSyncPath,
      managedPaths.retiredHourlyGitSyncConfigPath,
      systemCronPath,
    ]) {
      fs.writeFileSync(retiredPath, "retired\n", "utf8");
    }
    fs.writeFileSync(gitignorePath, "custom-rule\n", "utf8");

    migrateManagedInternalFiles({
      fs,
      openclawDir,
      systemCronPath,
      logger: { error: vi.fn() },
    });

    expect(fs.existsSync(managedPaths.retiredHourlyGitSyncPath)).toBe(false);
    expect(fs.existsSync(managedPaths.legacyHourlyGitSyncPath)).toBe(false);
    expect(fs.existsSync(managedPaths.retiredHourlyGitSyncConfigPath)).toBe(false);
    expect(fs.existsSync(systemCronPath)).toBe(false);
    expect(fs.readFileSync(gitignorePath, "utf8")).toBe("custom-rule\n");
  });

  it("still moves the legacy CLI approval marker into the managed directory", () => {
    const openclawDir = createTempOpenclawDir();
    const managedPaths = buildManagedPaths({ openclawDir });
    fs.writeFileSync(
      managedPaths.legacyCliDeviceAutoApprovedPath,
      '{"approvedAt":"old"}\n',
      "utf8",
    );

    migrateManagedInternalFiles({
      fs,
      openclawDir,
      systemCronPath: path.join(openclawDir, "missing-system-cron"),
      logger: { error: vi.fn() },
    });

    expect(fs.existsSync(managedPaths.legacyCliDeviceAutoApprovedPath)).toBe(false);
    expect(fs.readFileSync(managedPaths.cliDeviceAutoApprovedPath, "utf8")).toBe(
      '{"approvedAt":"old"}\n',
    );
  });

  it("is idempotent across repeated cleanup runs", () => {
    const openclawDir = createTempOpenclawDir();
    const systemCronPath = path.join(openclawDir, "openclaw-hourly-sync.cron");
    const managedPaths = buildManagedPaths({ openclawDir });
    fs.mkdirSync(managedPaths.internalDir, { recursive: true });
    fs.writeFileSync(managedPaths.retiredHourlyGitSyncPath, "retired\n", "utf8");

    for (let index = 0; index < 2; index += 1) {
      migrateManagedInternalFiles({
        fs,
        openclawDir,
        systemCronPath,
        logger: { error: vi.fn() },
      });
    }

    expect(fs.existsSync(managedPaths.retiredHourlyGitSyncPath)).toBe(false);
    expect(fs.existsSync(managedPaths.internalDir)).toBe(true);
  });
});
