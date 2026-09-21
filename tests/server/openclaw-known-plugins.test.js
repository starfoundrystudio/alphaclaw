const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listKnownOpenclawPluginIds,
} = require("../../lib/server/openclaw-known-plugins");

describe("server/openclaw-known-plugins", () => {
  let root;
  const manifest = (dir, id) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify({ id }));
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "known-plugins-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("collects bundled, extension, and managed npm project plugins", () => {
    const pkg = path.join(root, "openclaw");
    const state = path.join(root, "state");
    manifest(path.join(pkg, "dist", "extensions", "telegram"), "telegram");
    manifest(path.join(state, "extensions", "openclaw-teamyou-memory"), "openclaw-teamyou-memory");
    manifest(path.join(state, "npm", "projects", "openclaw-slack-abc", "node_modules", "@openclaw", "slack"), "slack");
    manifest(path.join(state, "npm", "projects", "x", "node_modules", "plain-plugin"), "plain");
    fs.mkdirSync(path.join(state, "npm", "projects", "empty"), { recursive: true });

    const ids = listKnownOpenclawPluginIds({ openclawDir: state, openclawPackageDir: pkg });
    expect([...ids].sort()).toEqual(["openclaw-teamyou-memory", "plain", "slack", "telegram"]);
  });

  it("returns an empty set when nothing exists", () => {
    expect(listKnownOpenclawPluginIds({ openclawDir: path.join(root, "none"), openclawPackageDir: null }).size).toBe(0);
  });

  it("finds the real bundled plugins of the installed OpenClaw", () => {
    const ids = listKnownOpenclawPluginIds({ openclawDir: path.join(root, "none") });
    expect(ids.has("telegram")).toBe(true);
    expect(ids.has("signal")).toBe(false);
  });
});
