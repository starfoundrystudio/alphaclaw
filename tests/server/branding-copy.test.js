const fs = require("fs");
const path = require("path");

// The product's user-facing name is Clawbridge. Identifiers, the npm package,
// env vars, and paths keep the lowercase/camel `alphaclaw`/`Alphaclaw` forms,
// so this guard only bans the display-cased brand token from shippable source.
const kLibRoot = path.join(__dirname, "..", "..", "lib");
const kSkippedDirs = new Set(["dist", "node_modules"]);
const kScannedExtensions = new Set([".js", ".mjs", ".json", ".md", ".html"]);
// The chat transcript filter must keep matching notes written before the
// rebrand, so the legacy literal is allowed on its defining line.
const kAllowedLinePattern = /kLegacySystemNotePrefix/;
const kBannedPatterns = [/AlphaClaw/, /Alpha Claw/i];

const collectFiles = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!kSkippedDirs.has(entry.name)) collectFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (kScannedExtensions.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
};

describe("branding copy guard", () => {
  it("never ships the retired AlphaClaw brand token in lib/", () => {
    const violations = [];
    for (const filePath of collectFiles(kLibRoot)) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (kAllowedLinePattern.test(line)) return;
        if (kBannedPatterns.some((pattern) => pattern.test(line))) {
          violations.push(
            `${path.relative(kLibRoot, filePath)}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
