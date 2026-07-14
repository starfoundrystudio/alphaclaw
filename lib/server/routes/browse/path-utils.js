const path = require("path");

const normalizeRelativePath = (inputPath) => {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath) return "";
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
};

const normalizePolicyPath = (inputPath) =>
  String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();

const resolveSafePath = (inputPath, kRootResolved, kRootWithSep, kRootDisplayName) => {
  const relativePath = normalizeRelativePath(inputPath);
  const absolutePath = path.resolve(kRootResolved, relativePath);
  const isInsideRoot =
    absolutePath === kRootResolved || absolutePath.startsWith(kRootWithSep);
  if (!isInsideRoot) {
    return { ok: false, error: `Path must stay within ${kRootDisplayName}` };
  }
  return { ok: true, relativePath, absolutePath };
};

const toRelativePath = (absolutePath, kRootResolved) => {
  const relative = path.relative(kRootResolved, absolutePath);
  return relative === "" ? "" : relative.split(path.sep).join("/");
};

const matchesPolicyPath = (policyPathSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  for (const policyPath of policyPathSet) {
    if (
      safeNormalizedPath === policyPath ||
      safeNormalizedPath.endsWith(`/${policyPath}`) ||
      safeNormalizedPath.startsWith(`${policyPath}/`) ||
      safeNormalizedPath.includes(`/${policyPath}/`)
    ) {
      return true;
    }
  }
  return false;
};

const matchesPolicyPathOrAncestor = (policyPathSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  if (matchesPolicyPath(policyPathSet, safeNormalizedPath)) return true;
  for (const policyPath of policyPathSet) {
    const policySegments = String(policyPath || "").split("/").filter(Boolean);
    for (let index = 1; index < policySegments.length; index += 1) {
      const policyAncestor = policySegments.slice(0, index).join("/");
      if (
        safeNormalizedPath === policyAncestor ||
        safeNormalizedPath.endsWith(`/${policyAncestor}`)
      ) {
        return true;
      }
    }
  }
  return false;
};

const matchesRootedPolicyPath = (policyPathSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  for (const policyPath of policyPathSet) {
    if (
      safeNormalizedPath === policyPath ||
      safeNormalizedPath.startsWith(`${policyPath}/`)
    ) {
      return true;
    }
  }
  return false;
};

const matchesRootNamePolicy = (policyRootNameSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath || safeNormalizedPath.includes("/")) return false;
  for (const policyRootName of policyRootNameSet) {
    if (policyRootName.endsWith("*")) {
      const prefix = policyRootName.slice(0, -1);
      if (prefix && safeNormalizedPath.startsWith(prefix)) return true;
      continue;
    }
    if (safeNormalizedPath === policyRootName) return true;
  }
  return false;
};

const isAnchoredPolicyPath = ({
  anchoredPaths,
  anchoredSubtrees,
  anchoredRootNames,
  normalizedPath,
  isDirectory = false,
}) =>
  matchesRootedPolicyPath(anchoredPaths, normalizedPath) ||
  matchesRootedPolicyPath(anchoredSubtrees, normalizedPath) ||
  (isDirectory && matchesRootNamePolicy(anchoredRootNames, normalizedPath));

module.exports = {
  normalizeRelativePath,
  normalizePolicyPath,
  resolveSafePath,
  toRelativePath,
  matchesPolicyPath,
  matchesPolicyPathOrAncestor,
  matchesRootedPolicyPath,
  matchesRootNamePolicy,
  isAnchoredPolicyPath,
};
