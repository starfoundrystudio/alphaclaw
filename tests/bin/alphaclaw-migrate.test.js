const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("bin/alphaclaw migrate", () => {
  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-migrate-bin-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      `${JSON.stringify(
        {
          gateway: { mode: "local" },
          plugins: {
            entries: {
              "active-memory": {
                enabled: true,
                config: {
                  modelFallbackPolicy: "default-remote",
                  queryMode: "recent",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies AlphaClaw migrations without starting the server", () => {
    const output = execSync(`node "${binPath}" --root-dir "${tmpDir}" migrate --fix`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "",
      },
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf8"),
    );

    expect(output).toContain("AlphaClaw migrations:");
    expect(output).toContain("fixed: 2026-06-remove-active-memory-model-fallback-policy");
    expect(output).not.toContain("SETUP_PASSWORD is missing");
    expect(
      config.plugins.entries["active-memory"].config.modelFallbackPolicy,
    ).toBeUndefined();
  });
});
