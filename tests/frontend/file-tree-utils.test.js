const loadFileTreeUtils = async () => import("../../lib/public/js/lib/file-tree-utils.js");

describe("frontend/file-tree-utils", () => {
  it("collects ancestor folder paths for selected files", async () => {
    const { collectAncestorFolderPaths } = await loadFileTreeUtils();

    expect(collectAncestorFolderPaths("devices/agents/config.json")).toEqual([
      "devices",
      "devices/agents",
    ]);
  });

  it("returns empty list for top-level files", async () => {
    const { collectAncestorFolderPaths } = await loadFileTreeUtils();

    expect(collectAncestorFolderPaths("openclaw.json")).toEqual([]);
    expect(collectAncestorFolderPaths("")).toEqual([]);
  });

  it("accepts only the active internal browse drag payload", async () => {
    const { getBrowseDragSource, kBrowseDragDataType } = await loadFileTreeUtils();
    const dataTransfer = {
      getData: (dataType) =>
        dataType === kBrowseDragDataType ? "workspace/notes.txt" : "",
    };

    expect(getBrowseDragSource(dataTransfer, "workspace/notes.txt")).toBe(
      "workspace/notes.txt",
    );
    expect(getBrowseDragSource(dataTransfer, "workspace/other.txt")).toBe("");
    expect(getBrowseDragSource(null, "workspace/notes.txt")).toBe("");
  });

  it("resolves deliberate folder and root move destinations", async () => {
    const { resolveBrowseMoveDestination } = await loadFileTreeUtils();

    expect(
      resolveBrowseMoveDestination("workspace/drafts/notes.txt", "workspace/archive"),
    ).toBe("workspace/archive/notes.txt");
    expect(
      resolveBrowseMoveDestination("workspace/drafts/notes.txt", ""),
    ).toBe("notes.txt");
  });

  it("treats same-folder and descendant drops as no-ops", async () => {
    const { resolveBrowseMoveDestination } = await loadFileTreeUtils();

    expect(
      resolveBrowseMoveDestination("workspace/drafts/notes.txt", "workspace/drafts"),
    ).toBe("");
    expect(
      resolveBrowseMoveDestination("workspace/drafts", "workspace/drafts/archive"),
    ).toBe("");
    expect(resolveBrowseMoveDestination("", "workspace")).toBe("");
  });
});
