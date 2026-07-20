const path = require("path");

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const isPathInside = (rootPath, candidatePath) => {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

module.exports = { isObject, isPathInside, parseJson };
