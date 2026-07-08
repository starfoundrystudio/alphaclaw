const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const kDefaultIgnoredDirectoryNames = new Set([".git", "node_modules"]);
const kDefaultIgnoredPathPrefixes = [
  "scratch/",
  "downloads/",
  "download/",
  "agent-downloads/",
  "agent_downloads/",
];
const kDefaultContentHashMaxBytes = 1024 * 1024;
const kDefaultScanMaxFiles = 50000;
const kDefaultScanMaxTotalBytes = 2 * 1024 * 1024 * 1024;
const kDefaultScanMaxHashedBytes = 25 * 1024 * 1024;
const kDefaultScanMaxElapsedMs = 2500;

const kContentFileExtensions = new Set([
  ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".yaml", ".yml",
  ".txt", ".sh", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
]);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseIgnoreList = (value = "") =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const normalizePathPrefix = (value = "") => {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized ? `${normalized}/` : "";
};

const buildScanOptions = (options = {}) => {
  const ignoredDirectoryNames = new Set([
    ...kDefaultIgnoredDirectoryNames,
    ...(Array.isArray(options.ignoredDirectoryNames)
      ? options.ignoredDirectoryNames
      : parseIgnoreList(process.env.ALPHACLAW_DOCTOR_WORKSPACE_IGNORE_DIRS)),
  ]);
  const ignoredPathPrefixes = [
    ...kDefaultIgnoredPathPrefixes,
    ...(Array.isArray(options.ignoredPathPrefixes)
      ? options.ignoredPathPrefixes
      : parseIgnoreList(process.env.ALPHACLAW_DOCTOR_WORKSPACE_IGNORE)),
  ]
    .map(normalizePathPrefix)
    .filter(Boolean);

  return {
    ignoredDirectoryNames,
    ignoredPathPrefixes,
    contentHashMaxBytes: parsePositiveInt(
      options.contentHashMaxBytes ?? process.env.ALPHACLAW_DOCTOR_CONTENT_HASH_MAX_BYTES,
      kDefaultContentHashMaxBytes,
    ),
    maxFiles: parsePositiveInt(
      options.maxFiles ?? process.env.ALPHACLAW_DOCTOR_SCAN_MAX_FILES,
      kDefaultScanMaxFiles,
    ),
    maxTotalBytes: parsePositiveInt(
      options.maxTotalBytes ?? process.env.ALPHACLAW_DOCTOR_SCAN_MAX_TOTAL_BYTES,
      kDefaultScanMaxTotalBytes,
    ),
    maxHashedBytes: parsePositiveInt(
      options.maxHashedBytes ?? process.env.ALPHACLAW_DOCTOR_SCAN_MAX_HASHED_BYTES,
      kDefaultScanMaxHashedBytes,
    ),
    maxElapsedMs: parsePositiveInt(
      options.maxElapsedMs ?? process.env.ALPHACLAW_DOCTOR_SCAN_MAX_ELAPSED_MS,
      kDefaultScanMaxElapsedMs,
    ),
  };
};

const isContentFile = (relativePath = "") => {
  const ext = path.extname(String(relativePath || "")).toLowerCase();
  return kContentFileExtensions.has(ext);
};

const hashFile = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
};

const normalizeRelativePath = (rootDir, filePath) =>
  path.relative(rootDir, filePath).split(path.sep).join("/");

const createScanState = (options) => ({
  startedAtMs: Date.now(),
  fileCount: 0,
  totalBytes: 0,
  hashedFileCount: 0,
  hashedBytes: 0,
  metadataOnlyFileCount: 0,
  ignoredDirectoryCount: 0,
  ignoredPaths: [],
  errorCount: 0,
  errors: [],
  degraded: false,
  degradedReasons: [],
  options: {
    contentHashMaxBytes: options.contentHashMaxBytes,
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    maxHashedBytes: options.maxHashedBytes,
    maxElapsedMs: options.maxElapsedMs,
    ignoredPathPrefixes: options.ignoredPathPrefixes,
    ignoredDirectoryNames: Array.from(options.ignoredDirectoryNames).sort(),
  },
});

const markDegraded = (scanState, reason) => {
  if (!reason || scanState.degradedReasons.includes(reason)) return;
  scanState.degraded = true;
  scanState.degradedReasons.push(reason);
};

const hasElapsedBudget = (scanState, options) =>
  Date.now() - scanState.startedAtMs <= options.maxElapsedMs;

const shouldIgnoreRelativePath = (relativePath, options) => {
  const normalized = normalizePathPrefix(relativePath);
  return options.ignoredPathPrefixes.some((prefix) => normalized.startsWith(prefix));
};

const walkFiles = (rootDir, options, scanState, currentDir = rootDir) => {
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (error) {
    scanState.errorCount += 1;
    if (scanState.errors.length < 10) {
      scanState.errors.push({
        path: normalizeRelativePath(rootDir, currentDir),
        error: error.message || "Could not read directory",
      });
    }
    markDegraded(scanState, "scan_errors");
    return [];
  }
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of sortedEntries) {
    if (entry.isDirectory()) {
      const directoryPath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(rootDir, directoryPath);
      if (
        options.ignoredDirectoryNames.has(entry.name) ||
        shouldIgnoreRelativePath(relativePath, options)
      ) {
        scanState.ignoredDirectoryCount += 1;
        if (scanState.ignoredPaths.length < 25) scanState.ignoredPaths.push(relativePath);
        continue;
      }
      files.push(...walkFiles(rootDir, options, scanState, directoryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path.join(currentDir, entry.name));
  }

  return files;
};

const getStatSignature = (entry) => {
  if (!entry || typeof entry !== "object") return "";
  const size = Number(entry.size || 0);
  const mtimeMs = Number(entry.mtimeMs || 0);
  return `${Number.isFinite(size) ? size : 0}:${Number.isFinite(mtimeMs) ? mtimeMs : 0}`;
};

const shouldHashFile = ({ relativePath, stat, scanState, options }) => {
  if (scanState.fileCount > options.maxFiles) {
    markDegraded(scanState, "max_files");
    return false;
  }
  if (scanState.totalBytes > options.maxTotalBytes) {
    markDegraded(scanState, "max_total_bytes");
    return false;
  }
  if (!hasElapsedBudget(scanState, options)) {
    markDegraded(scanState, "max_elapsed_ms");
    return false;
  }
  if (!isContentFile(relativePath)) return false;
  if (stat.size > options.contentHashMaxBytes) return false;
  if (scanState.hashedBytes + stat.size > options.maxHashedBytes) {
    markDegraded(scanState, "max_hashed_bytes");
    return false;
  }
  return true;
};

const buildMetadataEntry = (stat, extra = {}) => ({
  size: stat.size,
  mtimeMs: Math.round(Number(stat.mtimeMs || 0)),
  mode: stat.mode,
  ...extra,
});

const buildWorkspaceManifest = (rootDir, options = {}) => {
  const scanOptions = buildScanOptions(options);
  const scanState = createScanState(scanOptions);
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const files = walkFiles(normalizedRootDir, scanOptions, scanState);
  const manifest = {};

  for (const filePath of files) {
    const relativePath = normalizeRelativePath(normalizedRootDir, filePath);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      scanState.errorCount += 1;
      if (scanState.errors.length < 10) {
        scanState.errors.push({
          path: relativePath,
          error: error.message || "Could not stat file",
        });
      }
      markDegraded(scanState, "scan_errors");
      continue;
    }

    scanState.fileCount += 1;
    scanState.totalBytes += stat.size;
    const shouldHash = shouldHashFile({
      relativePath,
      stat,
      scanState,
      options: scanOptions,
    });

    if (shouldHash) {
      try {
        const hash = hashFile(filePath);
        scanState.hashedFileCount += 1;
        scanState.hashedBytes += stat.size;
        manifest[relativePath] = buildMetadataEntry(stat, {
          hash,
          fingerprintMode: "content",
        });
        continue;
      } catch (error) {
        scanState.errorCount += 1;
        if (scanState.errors.length < 10) {
          scanState.errors.push({
            path: relativePath,
            error: error.message || "Could not hash file",
          });
        }
        markDegraded(scanState, "scan_errors");
      }
    }

    scanState.metadataOnlyFileCount += 1;
    manifest[relativePath] = buildMetadataEntry(stat, {
      fingerprintMode: "metadata",
    });
  }

  scanState.elapsedMs = Date.now() - scanState.startedAtMs;
  return { manifest, scan: scanState };
};

const getManifestEntryHash = (entry) =>
  typeof entry === "object" && entry !== null ? String(entry.hash || "") : String(entry || "");

const getManifestEntrySize = (entry) =>
  typeof entry === "object" && entry !== null ? Number(entry.size || 0) : 0;

const getManifestEntryIdentity = (entry) => {
  const hash = getManifestEntryHash(entry);
  if (hash) return `hash:${hash}`;
  const statSignature = getStatSignature(entry);
  return statSignature ? `stat:${statSignature}` : "";
};

const computeWorkspaceFingerprintFromManifest = (manifest = {}) => {
  const hash = crypto.createHash("sha256");
  const entries = Object.entries(manifest).sort(([leftPath], [rightPath]) =>
    leftPath.localeCompare(rightPath),
  );

  hash.update("workspace-fingerprint-v2");
  for (const [relativePath, entry] of entries) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(getManifestEntryIdentity(entry));
    hash.update("\0");
  }

  return hash.digest("hex");
};

const buildWorkspaceScanWarning = (scan = null) => {
  if (!scan?.degraded && !scan?.ignoredDirectoryCount) return null;
  const reasons = Array.isArray(scan?.degradedReasons) ? scan.degradedReasons : [];
  const warnings = [];
  if (reasons.includes("max_files")) warnings.push("file count exceeded the scan budget");
  if (reasons.includes("max_total_bytes")) warnings.push("workspace size exceeded the scan budget");
  if (reasons.includes("max_hashed_bytes")) warnings.push("hashing exceeded the scan byte budget");
  if (reasons.includes("max_elapsed_ms")) warnings.push("scan time exceeded the budget");
  if (reasons.includes("scan_errors")) warnings.push("some paths could not be scanned");
  if (scan?.ignoredDirectoryCount) {
    warnings.push("scratch/download directories were excluded");
  }
  if (!warnings.length) return null;
  if (!scan?.degraded) {
    return `Workspace scan excluded ${scan.ignoredDirectoryCount} scratch/download director${scan.ignoredDirectoryCount === 1 ? "y" : "ies"} from fingerprinting.`;
  }
  return `Workspace scan used metadata-only fingerprinting for some files because ${warnings.join(", ")}.`;
};

const computeWorkspaceSnapshot = (rootDir, options = {}) => {
  const { manifest, scan } = buildWorkspaceManifest(rootDir, options);
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(manifest),
    manifest,
    scan: {
      ...scan,
      warning: buildWorkspaceScanWarning(scan),
    },
  };
};

const getPathChangeWeight = (relativePath = "") => {
  const normalizedPath = String(relativePath || "").trim().toLowerCase();
  if (!normalizedPath) return 1;
  if (
    normalizedPath === "agents.md" ||
    normalizedPath === "tools.md" ||
    normalizedPath === "readme.md" ||
    normalizedPath === "bootstrap.md" ||
    normalizedPath === "memory.md" ||
    normalizedPath === "user.md" ||
    normalizedPath === "identity.md"
  ) {
    return 4;
  }
  if (normalizedPath.startsWith("hooks/bootstrap/")) return 4;
  if (normalizedPath.startsWith("skills/")) return 3;
  if (normalizedPath.endsWith(".md")) return 2;
  return 1;
};

const kByteDeltaSmallThreshold = 100;
const kByteDeltaSignificantThreshold = 500;

const getModifiedFileScore = (relativePath, previousEntry, currentEntry) => {
  if (!isContentFile(relativePath)) return 1;
  const previousSize = getManifestEntrySize(previousEntry);
  const currentSize = getManifestEntrySize(currentEntry);
  if (!previousSize && !currentSize) return getPathChangeWeight(relativePath);
  const byteDelta = Math.abs(currentSize - previousSize);
  if (byteDelta < kByteDeltaSmallThreshold) return 1;
  if (byteDelta < kByteDeltaSignificantThreshold) return 2;
  return getPathChangeWeight(relativePath);
};

const calculateWorkspaceDelta = ({ previousManifest = {}, currentManifest = {} } = {}) => {
  const previousPaths = Object.keys(previousManifest);
  const currentPaths = Object.keys(currentManifest);
  const allPaths = Array.from(new Set([...previousPaths, ...currentPaths])).sort((left, right) =>
    left.localeCompare(right),
  );
  const changeSummary = {
    addedFilesCount: 0,
    removedFilesCount: 0,
    modifiedFilesCount: 0,
    changedFilesCount: 0,
    deltaScore: 0,
    changedPaths: [],
  };

  for (const relativePath of allPaths) {
    const previousEntry = previousManifest[relativePath];
    const currentEntry = currentManifest[relativePath];
    const hasPreviousEntry = Object.prototype.hasOwnProperty.call(previousManifest, relativePath);
    const hasCurrentEntry = Object.prototype.hasOwnProperty.call(currentManifest, relativePath);
    const previousIdentity = getManifestEntryIdentity(previousEntry);
    const currentIdentity = getManifestEntryIdentity(currentEntry);
    if (!hasPreviousEntry && hasCurrentEntry) {
      changeSummary.addedFilesCount += 1;
      changeSummary.deltaScore += getPathChangeWeight(relativePath);
    } else if (hasPreviousEntry && !hasCurrentEntry) {
      changeSummary.removedFilesCount += 1;
      changeSummary.deltaScore += getPathChangeWeight(relativePath);
    } else if (previousIdentity !== currentIdentity) {
      changeSummary.modifiedFilesCount += 1;
      changeSummary.deltaScore += getModifiedFileScore(relativePath, previousEntry, currentEntry);
    } else {
      continue;
    }
    changeSummary.changedFilesCount += 1;
    changeSummary.changedPaths.push(relativePath);
  }

  return changeSummary;
};

module.exports = {
  buildWorkspaceManifest,
  calculateWorkspaceDelta,
  computeWorkspaceFingerprintFromManifest,
  computeWorkspaceSnapshot,
  getManifestEntryIdentity,
  isContentFile,
  kDefaultContentHashMaxBytes,
};
