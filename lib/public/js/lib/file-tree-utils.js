export const kBrowseDragDataType = "application/x-alphaclaw-browse-path";

export const collectAncestorFolderPaths = (targetPath) => {
  const normalizedPath = String(targetPath || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (normalizedPath.length <= 1) return [];
  const ancestors = [];
  for (let index = 0; index < normalizedPath.length - 1; index += 1) {
    ancestors.push(normalizedPath.slice(0, index + 1).join("/"));
  }
  return ancestors;
};

export const getBrowseDragSource = (dataTransfer, activeSourcePath) => {
  const activeSource = String(activeSourcePath || "").trim();
  if (!activeSource || !dataTransfer?.getData) return "";
  const transferredSource = String(
    dataTransfer.getData(kBrowseDragDataType) || "",
  ).trim();
  return transferredSource === activeSource ? transferredSource : "";
};

export const resolveBrowseMoveDestination = (sourcePath, targetFolder = "") => {
  const normalizedSource = String(sourcePath || "").replaceAll("\\", "/").trim();
  const normalizedTargetFolder = String(targetFolder || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .trim();
  const basename = normalizedSource.split("/").filter(Boolean).pop() || "";
  if (!basename) return "";
  if (
    normalizedTargetFolder === normalizedSource ||
    normalizedTargetFolder.startsWith(`${normalizedSource}/`)
  ) {
    return "";
  }
  const destination = normalizedTargetFolder
    ? `${normalizedTargetFolder}/${basename}`
    : basename;
  return destination === normalizedSource ? "" : destination;
};
