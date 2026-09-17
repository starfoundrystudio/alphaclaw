const path = require("path");
const {
  kLockedBrowsePaths,
  kProtectedBrowsePaths,
  kAnchoredBrowsePaths,
  kAnchoredBrowseSubtrees,
  kAnchoredBrowseRootNames,
} = require("../../constants");
const {
  kDefaultTreeDepth,
  kMaxTreeDepth,
  kIgnoredDirectoryNames,
} = require("./constants");
const {
  normalizePolicyPath,
  resolveSafePath,
  toRelativePath,
  matchesPolicyPath,
  matchesPolicyPathOrAncestor,
  isAnchoredPolicyPath,
} = require("./path-utils");
const {
  isLikelyBinaryFile,
  getImageMimeType,
  getAudioMimeType,
  isSqliteFilePath,
} = require("./file-helpers");
const { readSqliteSummary, readSqliteTableData } = require("./sqlite");
const {
  runGitCommand,
  runGitCommandWithExitCode,
} = require("./git");

const registerBrowseRoutes = ({ app, fs, kRootDir }) => {
  const kRootResolved = path.resolve(kRootDir);
  const kRootWithSep = `${kRootResolved}${path.sep}`;
  const kRootDisplayName = "kRootDir/.openclaw";
  if (!fs.existsSync(kRootResolved)) {
    fs.mkdirSync(kRootResolved, { recursive: true });
  }

  const isAnchoredPath = (normalizedPath, isDirectory = false) =>
    isAnchoredPolicyPath({
      anchoredPaths: kAnchoredBrowsePaths,
      anchoredSubtrees: kAnchoredBrowseSubtrees,
      anchoredRootNames: kAnchoredBrowseRootNames,
      normalizedPath,
      isDirectory,
    });

  const isMoveSourceRestricted = (normalizedPath, isDirectory = false) =>
    isAnchoredPath(normalizedPath, isDirectory) ||
    matchesPolicyPathOrAncestor(kLockedBrowsePaths, normalizedPath) ||
    matchesPolicyPathOrAncestor(kProtectedBrowsePaths, normalizedPath);

  const isMoveDestinationRestricted = (normalizedPath, isDirectory = false) =>
    isAnchoredPath(normalizedPath, isDirectory) ||
    matchesPolicyPath(kLockedBrowsePaths, normalizedPath) ||
    matchesPolicyPath(kProtectedBrowsePaths, normalizedPath);

  const getTreeSkipReason = (error) => {
    const code = String(error?.code || "").trim();
    if (["EACCES", "EPERM", "ENOENT"].includes(code)) return code;
    return "";
  };

  const readVisibleDirectoryEntries = (absolutePath) =>
    fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory() && kIgnoredDirectoryNames.has(entry.name)) {
          return false;
        }
        return entry.isDirectory() || entry.isFile();
      });

  const buildTreeNode = (
    absolutePath,
    depthRemaining,
    skippedPaths,
    isRoot = false,
  ) => {
    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch (error) {
      const reason = getTreeSkipReason(error);
      if (!reason || isRoot) throw error;
      skippedPaths.push({
        path: toRelativePath(absolutePath, kRootResolved),
        reason,
      });
      return null;
    }
    const nodeName = path.basename(absolutePath);
    const nodePath = toRelativePath(absolutePath, kRootResolved);

    if (!stats.isDirectory()) {
      return { type: "file", name: nodeName, path: nodePath };
    }

    if (depthRemaining <= 0) {
      let hasMoreChildren = false;
      try {
        hasMoreChildren = readVisibleDirectoryEntries(absolutePath).length > 0;
      } catch (error) {
        const reason = getTreeSkipReason(error);
        if (!reason || isRoot) throw error;
        skippedPaths.push({ path: nodePath, reason });
        return {
          type: "folder",
          name: nodeName,
          path: nodePath,
          children: [],
          inaccessible: true,
        };
      }
      return {
        type: "folder",
        name: nodeName,
        path: nodePath,
        children: [],
        truncated: hasMoreChildren,
      };
    }

    let entries;
    try {
      entries = readVisibleDirectoryEntries(absolutePath);
    } catch (error) {
      const reason = getTreeSkipReason(error);
      if (!reason || isRoot) throw error;
      skippedPaths.push({ path: nodePath, reason });
      return {
        type: "folder",
        name: nodeName,
        path: nodePath,
        children: [],
        inaccessible: true,
      };
    }

    const children = entries
      .map((entry) =>
        buildTreeNode(
          path.join(absolutePath, entry.name),
          depthRemaining - 1,
          skippedPaths,
        ),
      )
      .filter(Boolean)
      .sort((leftNode, rightNode) => {
        if (leftNode.type !== rightNode.type) {
          return leftNode.type === "folder" ? -1 : 1;
        }
        return leftNode.name.localeCompare(rightNode.name);
      });

    return { type: "folder", name: nodeName, path: nodePath, children };
  };

  app.get("/api/browse/tree", (req, res) => {
    const depthValue = Number.parseInt(String(req.query.depth || ""), 10);
    const requestedDepth =
      Number.isFinite(depthValue) && depthValue > 0
        ? depthValue
        : kDefaultTreeDepth;
    const depth = Math.min(requestedDepth, kMaxTreeDepth);
    const requestedPath = String(req.query.path || "").trim();
    try {
      const resolvedPath = requestedPath
        ? resolveSafePath(
            requestedPath,
            kRootResolved,
            kRootWithSep,
            kRootDisplayName,
          )
        : { ok: true, absolutePath: kRootResolved };
      if (!resolvedPath.ok) {
        return res.status(400).json({ ok: false, error: resolvedPath.error });
      }
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ ok: false, error: "Path is not a folder" });
      }
      const skippedPaths = [];
      const tree = buildTreeNode(resolvedPath.absolutePath, depth, skippedPaths, true);
      return res.json({ ok: true, root: tree, skippedPaths });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not build file tree",
      });
    }
  });

  app.get("/api/browse/read", (req, res) => {
    const resolvedPath = resolveSafePath(
      req.query.path,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }

    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      if (isSqliteFilePath(resolvedPath.absolutePath)) {
        const sqliteSummary = readSqliteSummary(resolvedPath.absolutePath);
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "sqlite",
          sqliteSummary,
          content: "",
        });
      }
      const audioMimeType = getAudioMimeType(resolvedPath.absolutePath);
      if (audioMimeType) {
        const audioBytes = fs.readFileSync(resolvedPath.absolutePath);
        const audioDataUrl = `data:${audioMimeType};base64,${audioBytes.toString("base64")}`;
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "audio",
          mimeType: audioMimeType,
          audioDataUrl,
          content: "",
        });
      }
      if (isLikelyBinaryFile(fs, resolvedPath.absolutePath)) {
        const imageMimeType = getImageMimeType(resolvedPath.absolutePath);
        if (!imageMimeType) {
          return res
            .status(400)
            .json({ ok: false, error: "Binary files are not editable" });
        }
        const imageBytes = fs.readFileSync(resolvedPath.absolutePath);
        const imageDataUrl = `data:${imageMimeType};base64,${imageBytes.toString("base64")}`;
        return res.json({
          ok: true,
          path: resolvedPath.relativePath,
          kind: "image",
          mimeType: imageMimeType,
          imageDataUrl,
          content: "",
        });
      }
      const content = fs.readFileSync(resolvedPath.absolutePath, "utf8");
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        kind: "text",
        content,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not read file" });
    }
  });

  app.get("/api/browse/download", (req, res) => {
    const resolvedPath = resolveSafePath(
      req.query.path,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      const fileName = path.basename(resolvedPath.relativePath || resolvedPath.absolutePath);
      return res.download(resolvedPath.absolutePath, fileName, (error) => {
        if (!error || res.headersSent) return;
        return res
          .status(500)
          .json({ ok: false, error: error.message || "Could not download file" });
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not download file" });
    }
  });

  app.get("/api/browse/sqlite-table", (req, res) => {
    const resolvedPath = resolveSafePath(
      req.query.path,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    if (!isSqliteFilePath(resolvedPath.absolutePath)) {
      return res.status(400).json({ ok: false, error: "Path is not a sqlite file" });
    }
    const tableName = String(req.query.table || "").trim();
    const limit = req.query.limit;
    const offset = req.query.offset;
    const sqliteResult = readSqliteTableData(
      resolvedPath.absolutePath,
      tableName,
      limit,
      offset,
    );
    if (!sqliteResult.ok) {
      return res.status(400).json({
        ok: false,
        error: sqliteResult.error || "Could not read sqlite table",
      });
    }
    return res.json({
      ok: true,
      path: resolvedPath.relativePath,
      table: sqliteResult.table,
      columns: sqliteResult.columns,
      rows: sqliteResult.rows,
      limit: sqliteResult.limit,
      offset: sqliteResult.offset,
      totalRows: sqliteResult.totalRows,
    });
  });

  app.get("/api/browse/git-diff", async (req, res) => {
    const resolvedPath = resolveSafePath(
      req.query.path,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const relativePath = String(resolvedPath.relativePath || "").trim();
    if (!relativePath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }

    try {
      const statusResult = await runGitCommandWithExitCode(
        ["status", "--porcelain", "--", relativePath],
        kRootResolved,
      );
      if (
        !statusResult.ok &&
        /not a git repository/i.test(statusResult.stderr || "")
      ) {
        return res.status(400).json({ ok: false, error: "No git repo at this root" });
      }
      const statusLines = statusResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const rawStatus = statusLines[0]?.slice(0, 2) || "";
      const isUntracked = statusLines.some((line) => line.startsWith("??"));
      const statusKind =
        rawStatus === "??" || rawStatus.includes("A")
          ? "U"
          : rawStatus.includes("D")
            ? "D"
            : "M";

      const diffResult = isUntracked
        ? await runGitCommandWithExitCode(
            ["diff", "--no-index", "--", "/dev/null", resolvedPath.absolutePath],
            kRootResolved,
          )
        : await runGitCommandWithExitCode(
            ["diff", "HEAD", "--", relativePath],
            kRootResolved,
          );

      const untrackedAllowedFailure =
        isUntracked && diffResult.exitCode === 1 && diffResult.stdout;
      if (!diffResult.ok && !untrackedAllowedFailure) {
        return res.status(500).json({
          ok: false,
          error: diffResult.stderr || diffResult.error || "Could not load file diff",
        });
      }

      const content = String(diffResult.stdout || "")
        .replaceAll(resolvedPath.absolutePath, relativePath)
        .trimEnd();
      return res.json({
        ok: true,
        path: relativePath,
        content,
        statusKind,
        isDeleted: statusKind === "D",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load file diff",
      });
    }
  });

  app.put("/api/browse/write", async (req, res) => {
    const { path: targetPath, content } = req.body || {};
    const resolvedPath = resolveSafePath(
      targetPath,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return res.status(403).json({
        ok: false,
        error: "This file is managed by Clawbridge and cannot be edited.",
      });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "content must be a string" });
    }

    try {
      const stats = fs.statSync(resolvedPath.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ ok: false, error: "Path is not a file" });
      }
      fs.writeFileSync(resolvedPath.absolutePath, content, "utf8");
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not save file" });
    }
  });

  app.post("/api/browse/create-file", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    if (!targetPath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const resolvedPath = resolveSafePath(
      targetPath,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return res.status(403).json({
        ok: false,
        error: "Cannot create files in a locked path.",
      });
    }
    try {
      if (fs.existsSync(resolvedPath.absolutePath)) {
        return res
          .status(409)
          .json({ ok: false, error: "A file or folder already exists at this path" });
      }
      const parentDir = path.dirname(resolvedPath.absolutePath);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(resolvedPath.absolutePath, "", "utf8");
      return res.json({ ok: true, path: resolvedPath.relativePath });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not create file" });
    }
  });

  app.post("/api/browse/create-folder", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    if (!targetPath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const resolvedPath = resolveSafePath(
      targetPath,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    if (matchesPolicyPath(kLockedBrowsePaths, normalizedPolicyPath)) {
      return res.status(403).json({
        ok: false,
        error: "Cannot create folders in a locked path.",
      });
    }
    try {
      if (fs.existsSync(resolvedPath.absolutePath)) {
        return res
          .status(409)
          .json({ ok: false, error: "A file or folder already exists at this path" });
      }
      fs.mkdirSync(resolvedPath.absolutePath, { recursive: true });
      return res.json({ ok: true, path: resolvedPath.relativePath });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not create folder" });
    }
  });

  app.post("/api/browse/move", (req, res) => {
    const fromPath = String(req.body?.from || "").trim();
    const toPath = String(req.body?.to || "").trim();
    if (!fromPath || !toPath) {
      return res.status(400).json({ ok: false, error: "from and to are required" });
    }
    const resolvedFrom = resolveSafePath(fromPath, kRootResolved, kRootWithSep, kRootDisplayName);
    if (!resolvedFrom.ok) {
      return res.status(400).json({ ok: false, error: resolvedFrom.error });
    }
    const resolvedTo = resolveSafePath(toPath, kRootResolved, kRootWithSep, kRootDisplayName);
    if (!resolvedTo.ok) {
      return res.status(400).json({ ok: false, error: resolvedTo.error });
    }
    const normalizedFromPolicy = normalizePolicyPath(resolvedFrom.relativePath);
    const normalizedToPolicy = normalizePolicyPath(resolvedTo.relativePath);
    try {
      if (!fs.existsSync(resolvedFrom.absolutePath)) {
        return res.status(404).json({ ok: false, error: "Source path does not exist" });
      }
      const sourceStats = fs.statSync(resolvedFrom.absolutePath);
      const sourceIsDirectory = sourceStats.isDirectory();
      if (!sourceStats.isFile() && !sourceIsDirectory) {
        return res.status(400).json({ ok: false, error: "Source path is not a file or folder" });
      }
      if (isMoveSourceRestricted(normalizedFromPolicy, sourceIsDirectory)) {
        return res.status(403).json({ ok: false, error: "Source path is protected and cannot be moved." });
      }
      if (isMoveDestinationRestricted(normalizedToPolicy, sourceIsDirectory)) {
        return res.status(403).json({ ok: false, error: "Cannot move into a protected path." });
      }
      if (fs.existsSync(resolvedTo.absolutePath)) {
        return res.status(409).json({ ok: false, error: "A file or folder already exists at the destination" });
      }
      const parentDir = path.dirname(resolvedTo.absolutePath);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.renameSync(resolvedFrom.absolutePath, resolvedTo.absolutePath);
      return res.json({ ok: true, from: resolvedFrom.relativePath, to: resolvedTo.relativePath });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not move path" });
    }
  });

  app.delete("/api/browse/delete", (req, res) => {
    const targetPath = String(req.body?.path || "").trim();
    const resolvedPath = resolveSafePath(
      targetPath,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const normalizedPolicyPath = normalizePolicyPath(resolvedPath.relativePath);
    try {
      if (!fs.existsSync(resolvedPath.absolutePath)) {
        return res.status(404).json({ ok: false, error: "Path does not exist" });
      }
      const stats = fs.statSync(resolvedPath.absolutePath);
      const isDirectory = stats.isDirectory();
      if (!stats.isFile() && !isDirectory) {
        return res.status(400).json({ ok: false, error: "Path is not a file or folder" });
      }
      if (isMoveSourceRestricted(normalizedPolicyPath, isDirectory)) {
        return res.status(403).json({
          ok: false,
          error: "This path cannot be deleted from the explorer.",
        });
      }
      fs.rmSync(resolvedPath.absolutePath, { recursive: isDirectory, force: true });
      return res.json({
        ok: true,
        path: resolvedPath.relativePath,
        type: isDirectory ? "folder" : "file",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not delete path",
      });
    }
  });

  app.post("/api/browse/restore", async (req, res) => {
    const { path: targetPath } = req.body || {};
    const resolvedPath = resolveSafePath(
      targetPath,
      kRootResolved,
      kRootWithSep,
      kRootDisplayName,
    );
    if (!resolvedPath.ok) {
      return res.status(400).json({ ok: false, error: resolvedPath.error });
    }
    const relativePath = String(resolvedPath.relativePath || "").trim();
    if (!relativePath) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const restoreResult = await runGitCommand(
      ["restore", "--staged", "--worktree", "--", relativePath],
      kRootResolved,
    );
    const fallbackResult = !restoreResult.ok
      ? await runGitCommand(["checkout", "--", relativePath], kRootResolved)
      : { ok: true };
    if (!restoreResult.ok && !fallbackResult.ok) {
      return res.status(500).json({
        ok: false,
        error:
          restoreResult.error ||
          fallbackResult.error ||
          "Could not restore file from git",
      });
    }
    return res.json({
      ok: true,
      path: relativePath,
      restored: fs.existsSync(resolvedPath.absolutePath),
    });
  });
};

module.exports = { registerBrowseRoutes };
