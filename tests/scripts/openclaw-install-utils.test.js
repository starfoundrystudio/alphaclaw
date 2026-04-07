const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  findProjectRootFromOpenclawDir,
  resolveOpenclawDirFromMainPath,
  runOpenclawBundledPluginPostinstall,
} = require("../../scripts/openclaw-install-utils");

const kTempDirs = [];

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-openclaw-install-"));
  kTempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (kTempDirs.length > 0) {
    fs.rmSync(kTempDirs.pop(), { recursive: true, force: true });
  }
});

describe("openclaw-install-utils", () => {
  it("finds the enclosing project root from an openclaw install path", () => {
    const projectRoot = makeTempDir();
    const openclawDir = path.join(projectRoot, "node_modules", "openclaw");

    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package-lock.json"), "{}");

    expect(findProjectRootFromOpenclawDir(openclawDir)).toBe(projectRoot);
  });

  it("resolves the openclaw package root from its main entry path", () => {
    const openclawDir = makeTempDir();
    const distDir = path.join(openclawDir, "dist");

    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );

    expect(resolveOpenclawDirFromMainPath(path.join(distDir, "index.js"))).toBe(openclawDir);
  });

  it("runs OpenClaw's bundled plugin postinstall script when present", () => {
    const openclawDir = makeTempDir();
    const scriptsDir = path.join(openclawDir, "scripts");
    const markerPath = path.join(openclawDir, "ran.txt");

    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "postinstall-bundled-plugins.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'writeFileSync(join(process.cwd(), "ran.txt"), "ok");',
      ].join("\n"),
    );

    runOpenclawBundledPluginPostinstall({ openclawDir });

    expect(fs.readFileSync(markerPath, "utf8")).toBe("ok");
  });
});
