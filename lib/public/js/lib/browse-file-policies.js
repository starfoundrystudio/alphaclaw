const kBrowseFilePoliciesUrl = new URL(
  "../../shared/browse-file-policies.json",
  import.meta.url,
);

let kBrowseFilePolicies = {
  protectedPaths: [],
  anchoredPaths: [],
  anchoredSubtrees: [],
  anchoredRootNames: [],
  lockedPaths: [],
};
try {
  const policyResponse = await fetch(kBrowseFilePoliciesUrl);
  if (policyResponse.ok) {
    const policyJson = await policyResponse.json();
    if (policyJson && typeof policyJson === "object") {
      kBrowseFilePolicies = policyJson;
    }
  }
} catch {}

export const normalizeBrowsePolicyPath = (inputPath) =>
  String(inputPath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();

const toNormalizedPolicySet = (values) =>
  new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeBrowsePolicyPath(value))
      .filter(Boolean),
  );

export const kProtectedBrowsePaths = toNormalizedPolicySet(
  kBrowseFilePolicies?.protectedPaths,
);

export const kLockedBrowsePaths = toNormalizedPolicySet(
  kBrowseFilePolicies?.lockedPaths,
);

export const kAnchoredBrowsePaths = toNormalizedPolicySet(
  kBrowseFilePolicies?.anchoredPaths,
);

export const kAnchoredBrowseSubtrees = toNormalizedPolicySet(
  kBrowseFilePolicies?.anchoredSubtrees,
);

export const kAnchoredBrowseRootNames = toNormalizedPolicySet(
  kBrowseFilePolicies?.anchoredRootNames,
);

export const matchesBrowsePolicyPath = (policyPathSet, normalizedPath) => {
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

export const matchesBrowsePolicyPathOrAncestor = (
  policyPathSet,
  normalizedPath,
) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  if (matchesBrowsePolicyPath(policyPathSet, safeNormalizedPath)) return true;
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

export const matchesRootedBrowsePolicyPath = (
  policyPathSet,
  normalizedPath,
) => {
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

export const matchesBrowseRootNamePolicy = (
  policyRootNameSet,
  normalizedPath,
) => {
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

export const isAnchoredBrowsePath = (
  normalizedPath,
  { isDirectory = false } = {},
) =>
  matchesRootedBrowsePolicyPath(kAnchoredBrowsePaths, normalizedPath) ||
  matchesRootedBrowsePolicyPath(kAnchoredBrowseSubtrees, normalizedPath) ||
  (isDirectory &&
    matchesBrowseRootNamePolicy(kAnchoredBrowseRootNames, normalizedPath));

export const isBrowsePathMoveRestricted = (normalizedPath, options) =>
  isAnchoredBrowsePath(normalizedPath, options) ||
  matchesBrowsePolicyPathOrAncestor(kLockedBrowsePaths, normalizedPath) ||
  matchesBrowsePolicyPathOrAncestor(kProtectedBrowsePaths, normalizedPath);

export const isBrowseDropTargetRestricted = (normalizedPath, options) =>
  isAnchoredBrowsePath(normalizedPath, options) ||
  matchesBrowsePolicyPath(kLockedBrowsePaths, normalizedPath) ||
  matchesBrowsePolicyPath(kProtectedBrowsePaths, normalizedPath);
