const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kBin = path.join(__dirname, "..", "..", "bin", "alphaclaw.js");

const run = (args) =>
  spawnSync(process.execPath, [kBin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALPHACLAW_ROOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-bin-")),
    },
    timeout: 30000,
  });

describe("bin/alphaclaw unknown subcommands", () => {
  it("rejects a command it does not know instead of falling through to start", () => {
    // The retired command a 7.1-era host script still called (G2 finding #2).
    const result = run(["finalize-openclaw-startup-state"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown command: finalize-openclaw-startup-state/);
    expect(result.stdout).not.toMatch(/starting server|Setup complete/);
  });

  it("still prints help and version", () => {
    expect(run(["--help"]).status).toBe(0);
    expect(run(["--help"]).stdout).toMatch(/Usage: alphaclaw <command>/);
    const version = run(["version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
