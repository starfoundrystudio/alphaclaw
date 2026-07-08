const fs = require("fs");
const os = require("os");
const path = require("path");

const loadWorkspaceFingerprint = () => {
  const modulePath = require.resolve("../../lib/server/doctor/workspace-fingerprint");
  delete require.cache[modulePath];
  return require(modulePath);
};

describe("server/doctor/workspace-fingerprint", () => {
  it("hashes small content files but does not read large PDFs", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-large-pdf-"));
    const notesPath = path.join(workspaceRoot, "AGENTS.md");
    const pdfPath = path.join(workspaceRoot, "report.pdf");
    fs.writeFileSync(notesPath, "# Guidance\n", "utf8");
    fs.writeFileSync(pdfPath, Buffer.alloc(2 * 1024 * 1024, 1));

    const { computeWorkspaceSnapshot } = loadWorkspaceFingerprint();
    const readSpy = vi.spyOn(fs, "readFileSync");
    const snapshot = computeWorkspaceSnapshot(workspaceRoot);

    expect(snapshot.manifest["AGENTS.md"]).toEqual(
      expect.objectContaining({
        fingerprintMode: "content",
        hash: expect.any(String),
        size: 11,
      }),
    );
    expect(snapshot.manifest["report.pdf"]).toEqual(
      expect.objectContaining({
        fingerprintMode: "metadata",
        size: 2 * 1024 * 1024,
        mtimeMs: expect.any(Number),
      }),
    );
    expect(snapshot.manifest["report.pdf"]).not.toHaveProperty("hash");
    expect(readSpy).toHaveBeenCalledWith(notesPath);
    expect(readSpy).not.toHaveBeenCalledWith(pdfPath);
    readSpy.mockRestore();
  });

  it("detects metadata-only file changes through size and mtime", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-metadata-"));
    const pdfPath = path.join(workspaceRoot, "report.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("first"));

    const { calculateWorkspaceDelta, computeWorkspaceSnapshot } = loadWorkspaceFingerprint();
    const initialSnapshot = computeWorkspaceSnapshot(workspaceRoot);
    const nextMtime = new Date(Date.now() + 60000);
    fs.utimesSync(pdfPath, nextMtime, nextMtime);
    const nextSnapshot = computeWorkspaceSnapshot(workspaceRoot);

    expect(nextSnapshot.fingerprint).not.toBe(initialSnapshot.fingerprint);
    expect(
      calculateWorkspaceDelta({
        previousManifest: initialSnapshot.manifest,
        currentManifest: nextSnapshot.manifest,
      }),
    ).toEqual(
      expect.objectContaining({
        modifiedFilesCount: 1,
        changedFilesCount: 1,
        changedPaths: ["report.pdf"],
      }),
    );
  });

  it("ignores scratch and download directories by default", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-ignore-"));
    fs.mkdirSync(path.join(workspaceRoot, "scratch"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "downloads"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "scratch", "notes.md"), "ignored", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "downloads", "report.pdf"), "ignored", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Visible\n", "utf8");

    const { computeWorkspaceSnapshot } = loadWorkspaceFingerprint();
    const snapshot = computeWorkspaceSnapshot(workspaceRoot);

    expect(Object.keys(snapshot.manifest)).toEqual(["README.md"]);
    expect(snapshot.scan.ignoredDirectoryCount).toBe(2);
    expect(snapshot.scan.ignoredPaths).toEqual(["downloads", "scratch"]);
    expect(snapshot.scan.warning).toContain("excluded 2 scratch/download directories");
  });

  it("falls back to metadata-only fingerprinting when scan budgets are exceeded", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-budget-"));
    fs.writeFileSync(path.join(workspaceRoot, "a.md"), "A", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "b.md"), "B", "utf8");

    const { computeWorkspaceSnapshot } = loadWorkspaceFingerprint();
    const snapshot = computeWorkspaceSnapshot(workspaceRoot, { maxFiles: 1 });

    expect(snapshot.scan.degraded).toBe(true);
    expect(snapshot.scan.degradedReasons).toContain("max_files");
    expect(snapshot.scan.warning).toContain("file count exceeded the scan budget");
    expect(snapshot.manifest["a.md"].fingerprintMode).toBe("content");
    expect(snapshot.manifest["b.md"]).toEqual(
      expect.objectContaining({
        fingerprintMode: "metadata",
      }),
    );
    expect(snapshot.manifest["b.md"]).not.toHaveProperty("hash");
  });
});
