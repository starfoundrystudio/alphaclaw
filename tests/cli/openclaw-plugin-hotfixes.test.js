const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyOpenclawPluginHotfixes } = require("../../lib/cli/openclaw-plugin-hotfixes");

const kProvider =
  'createSlackBoltApp({ interop, slackMode, clientOptions, dispatcher: slackDispatcher, wrapReceiver: x });';

describe("cli/openclaw-plugin-hotfixes", () => {
  let openclawDir;
  const logger = { log: vi.fn(), warn: vi.fn() };
  const installSlack = (version, text = kProvider, project = "openclaw-slack-abc") => {
    const pkg = path.join(openclawDir, "npm", "projects", project, "node_modules", "@openclaw", "slack");
    fs.mkdirSync(path.join(pkg, "dist", ".setup"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openclaw/slack", version }));
    const file = path.join(pkg, "dist", ".setup", "provider-w36VTgZ3.mjs");
    fs.writeFileSync(file, text);
    return file;
  };
  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix-"));
  });
  afterEach(() => fs.rmSync(openclawDir, { recursive: true, force: true }));

  it("removes the OpenClaw dispatcher from Slack Socket Mode on 2026.9.5, once", () => {
    const file = installSlack("2026.9.5");
    const first = applyOpenclawPluginHotfixes({ openclawDir, logger });
    expect(first.map((r) => r.status)).toEqual(["applied"]);
    const patched = fs.readFileSync(file, "utf8");
    expect(patched).not.toContain("dispatcher: slackDispatcher,");
    expect(patched).toContain("clientOptions, dispatcher: /* clawbridge-hotfix:slack-socket-mode-proxy-dispatcher */ (process.env.HTTPS_PROXY");
    expect(patched).toContain('createRequire(import.meta.url)("undici").EnvHttpProxyAgent)() : void 0, wrapReceiver');

    const second = applyOpenclawPluginHotfixes({ openclawDir, logger });
    expect(second.map((r) => r.status)).toEqual(["already-applied"]);
    expect(fs.readFileSync(file, "utf8")).toBe(patched);
  });

  it("leaves other versions and unexpected builds alone", () => {
    const other = installSlack("2026.9.6");
    expect(applyOpenclawPluginHotfixes({ openclawDir, logger })).toEqual([]);
    expect(fs.readFileSync(other, "utf8")).toBe(kProvider);

    fs.rmSync(path.join(openclawDir, "npm"), { recursive: true, force: true });
    const twice = installSlack("2026.9.5", `${kProvider}\n${kProvider}`);
    expect(applyOpenclawPluginHotfixes({ openclawDir, logger }).map((r) => r.status)).toEqual(["ambiguous"]);
    expect(fs.readFileSync(twice, "utf8")).toBe(`${kProvider}\n${kProvider}`);
  });

  it("does nothing when Slack is not installed", () => {
    expect(applyOpenclawPluginHotfixes({ openclawDir, logger })).toEqual([]);
  });
});
