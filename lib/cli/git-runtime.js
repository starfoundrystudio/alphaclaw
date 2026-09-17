const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const listGitCandidates = ({ execSyncImpl = execSync } = {}) => {
  try {
    return String(
      execSyncImpl("which -a git", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }),
    )
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const canExecute = ({ fsModule = fs, candidatePath = "" } = {}) => {
  const normalizedCandidatePath = String(candidatePath || "").trim();
  if (!normalizedCandidatePath) return false;
  try {
    fsModule.accessSync(normalizedCandidatePath, fsModule.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveRealGitPath = ({
  execSyncImpl = execSync,
  fsModule = fs,
  shimPath = "",
  hintedPath = "",
} = {}) => {
  const normalizedShimPath = String(shimPath || "").trim()
    ? path.resolve(String(shimPath || "").trim())
    : "";
  const candidates = [
    String(process.env.ALPHACLAW_REAL_GIT || "").trim(),
    String(hintedPath || "").trim(),
    "/usr/bin/git",
    "/bin/git",
    "/usr/libexec/git-core/git",
    "/usr/local/bin/git.real",
  ];

  for (const candidatePath of [...candidates, ...listGitCandidates({ execSyncImpl })]) {
    const normalizedCandidatePath = String(candidatePath || "").trim();
    if (!normalizedCandidatePath) continue;
    const resolvedCandidatePath = path.resolve(normalizedCandidatePath);
    if (normalizedShimPath && resolvedCandidatePath === normalizedShimPath) continue;
    if (!canExecute({ fsModule, candidatePath: resolvedCandidatePath })) continue;
    return resolvedCandidatePath;
  }

  return "";
};

module.exports = {
  resolveRealGitPath,
};
