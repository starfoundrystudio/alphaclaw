const path = require("path");
const {
  importPortableAuthStores,
} = require("../../lib/server/onboarding/import/portable-auth-import");

describe("portable auth import", () => {
  it("persists each exported agent store into the runtime database", () => {
    const openclawDir = "/tmp/openclaw";
    const mainStore = path.join(
      openclawDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const fs = {
      readdirSync: vi.fn(() => [
        { name: "main", isDirectory: () => true },
        { name: "research", isDirectory: () => true },
      ]),
      existsSync: vi.fn((filePath) => filePath === mainStore),
    };
    const authProfiles = { syncConfigAuthReferencesForAgent: vi.fn() };

    expect(importPortableAuthStores({ fs, openclawDir, authProfiles })).toEqual({
      importedAgentCount: 1,
    });
    expect(authProfiles.syncConfigAuthReferencesForAgent).toHaveBeenCalledWith("main");
  });
});
