const fs = require("fs");
const path = require("path");
const { isObject, isPathInside, parseJson } = require("./shared");

const kCodexBindingSidecarSuffix = ".codex-app-server.json";

const listSessionStorePaths = ({ fsModule = fs, openclawDir }) => {
  const storePaths = [path.join(openclawDir, "sessions", "sessions.json")];
  const agentsDir = path.join(openclawDir, "agents");
  try {
    for (const entry of fsModule.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      storePaths.push(
        path.join(agentsDir, entry.name, "sessions", "sessions.json"),
      );
    }
  } catch {}
  return storePaths.filter((storePath) => fsModule.existsSync(storePath));
};

const normalizeSessionString = (value) =>
  typeof value === "string" ? value.trim() : "";

const resolveSessionTranscriptPath = ({ storePath, entry }) => {
  const sessionId = normalizeSessionString(entry?.sessionId);
  if (!sessionId) return null;
  const sessionsDir = path.dirname(storePath);
  const sessionFile = normalizeSessionString(entry?.sessionFile);
  if (!sessionFile) return path.join(sessionsDir, `${sessionId}.jsonl`);
  return path.isAbsolute(sessionFile)
    ? path.resolve(sessionFile)
    : path.resolve(sessionsDir, sessionFile);
};

const collectSessionOwnersByTranscript = ({ fsModule = fs, openclawDir }) => {
  const owners = new Map();
  for (const storePath of listSessionStorePaths({ fsModule, openclawDir })) {
    const store = parseJson(fsModule.readFileSync(storePath, "utf8"), null);
    if (!isObject(store)) continue;
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!isObject(entry)) continue;
      const transcriptPath = resolveSessionTranscriptPath({ storePath, entry });
      if (!transcriptPath || !isPathInside(openclawDir, transcriptPath)) continue;
      const resolvedPath = path.resolve(transcriptPath);
      const candidates = owners.get(resolvedPath) || [];
      candidates.push({
        sessionKey,
        storePath,
        transcriptPath: resolvedPath,
        agentHarnessId: normalizeSessionString(entry.agentHarnessId),
      });
      owners.set(resolvedPath, candidates);
    }
  }
  return owners;
};

const walkCodexBindingSidecars = ({ fsModule = fs, openclawDir }) => {
  const roots = [path.join(openclawDir, "sessions")];
  const agentsDir = path.join(openclawDir, "agents");
  try {
    for (const entry of fsModule.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      roots.push(path.join(agentsDir, entry.name, "sessions"));
    }
  } catch {}

  const sidecars = [];
  const pending = roots.map((directory) => ({ directory, depth: 0 }));
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fsModule.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(kCodexBindingSidecarSuffix)) {
        sidecars.push(path.resolve(entryPath));
      } else if (entry.isDirectory() && current.depth < 16) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return sidecars.sort();
};

const inspectForeignHarnessCodexSidecars = ({ fsModule = fs, openclawDir }) => {
  const ownersByTranscript = collectSessionOwnersByTranscript({
    fsModule,
    openclawDir,
  });
  const candidates = [];
  for (const sidecarPath of walkCodexBindingSidecars({ fsModule, openclawDir })) {
    const transcriptPath = sidecarPath.slice(0, -kCodexBindingSidecarSuffix.length);
    const owners = ownersByTranscript.get(transcriptPath) || [];
    if (owners.length !== 1) continue;
    const [owner] = owners;
    if (!owner.agentHarnessId || owner.agentHarnessId === "codex") continue;
    candidates.push({ sidecarPath, transcriptPath, owner });
  }
  return { pending: candidates.length > 0, candidates };
};

const firstAvailableArchivePath = ({ fsModule = fs, sidecarPath }) => {
  const defaultPath = `${sidecarPath}.migrated`;
  if (!fsModule.existsSync(defaultPath)) return defaultPath;
  const source = fsModule.readFileSync(sidecarPath);
  const existing = fsModule.readFileSync(defaultPath);
  if (source.equals(existing)) return null;
  for (let index = 2; ; index += 1) {
    const candidate = `${sidecarPath}.migrated.${index}`;
    if (!fsModule.existsSync(candidate)) return candidate;
  }
};

const repairForeignHarnessCodexSidecars = ({ fsModule = fs, openclawDir }) => {
  const inspection = inspectForeignHarnessCodexSidecars({ fsModule, openclawDir });
  if (!inspection.pending) {
    return {
      changed: false,
      changes: ["No uniquely foreign-owned Codex binding sidecars required repair."],
    };
  }

  const changes = [];
  for (const candidate of inspection.candidates) {
    const archivePath = firstAvailableArchivePath({
      fsModule,
      sidecarPath: candidate.sidecarPath,
    });
    if (archivePath) {
      fsModule.renameSync(candidate.sidecarPath, archivePath);
    } else {
      fsModule.rmSync(candidate.sidecarPath, { force: true });
    }
    changes.push(
      `Archived stale Codex binding sidecar for ${candidate.owner.sessionKey}; session is owned by harness ${candidate.owner.agentHarnessId}.`,
    );
  }
  return { changed: true, changes };
};

module.exports = {
  inspectForeignHarnessCodexSidecars,
  repairForeignHarnessCodexSidecars,
  walkCodexBindingSidecars,
};
