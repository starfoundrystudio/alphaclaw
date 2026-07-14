const browseFilePolicies = require("../../lib/public/shared/browse-file-policies.json");

const loadBrowseFilePolicies = async () => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => browseFilePolicies,
    })),
  );
  return import("../../lib/public/js/lib/browse-file-policies.js");
};

describe("frontend/browse-file-policies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("anchors OpenClaw runtime subtrees but not lookalikes in workspaces", async () => {
    const { isBrowsePathMoveRestricted } = await loadBrowseFilePolicies();

    expect(isBrowsePathMoveRestricted("agents/main/agent/openclaw-agent.sqlite")).toBe(true);
    expect(isBrowsePathMoveRestricted("state/openclaw.sqlite-wal")).toBe(true);
    expect(isBrowsePathMoveRestricted("workspace/project/agents")).toBe(false);
  });

  it("anchors only root workspace directories, not their contents", async () => {
    const { isBrowsePathMoveRestricted } = await loadBrowseFilePolicies();

    expect(
      isBrowsePathMoveRestricted("workspace-ops", { isDirectory: true }),
    ).toBe(true);
    expect(
      isBrowsePathMoveRestricted("workspace-ops/notes.txt"),
    ).toBe(false);
    expect(
      isBrowsePathMoveRestricted("archive/workspace-ops", {
        isDirectory: true,
      }),
    ).toBe(false);
  });

  it("blocks protected and locked path ancestors from being moved", async () => {
    const { isBrowsePathMoveRestricted } = await loadBrowseFilePolicies();

    expect(
      isBrowsePathMoveRestricted("workspace/hooks", { isDirectory: true }),
    ).toBe(true);
    expect(isBrowsePathMoveRestricted("devices", { isDirectory: true })).toBe(true);
  });
});
