const fs = require("fs");
const os = require("os");
const path = require("path");

describe("server/env", () => {
  let tmpDir;
  let envFilePath;
  let previousSlackToken;
  let previousRootDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-"));
    envFilePath = path.join(tmpDir, ".env");
    previousSlackToken = process.env.SLACK_BOT_TOKEN;
    // vi.doMock does not intercept require(), so env.js loads the real
    // constants; point their root at the temp dir so no test touches
    // ~/.alphaclaw/.env.
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
    process.env.ALPHACLAW_ROOT_DIR = tmpDir;
    delete require.cache[require.resolve("../../lib/server/constants")];
    delete require.cache[require.resolve("../../lib/server/env")];
    vi.resetModules();
    vi.doMock("../../lib/server/constants", () => ({
      ENV_FILE_PATH: envFilePath,
      kKnownVars: [{ key: "SLACK_BOT_TOKEN" }],
    }));
  });

  afterEach(() => {
    if (previousSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousSlackToken;
    if (previousRootDir === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
    else process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    vi.doUnmock("../../lib/server/constants");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves inherited env vars when clearMissing is false", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-deployment";
    fs.writeFileSync(envFilePath, "");
    const { reloadEnv } = require("../../lib/server/env");

    const changed = reloadEnv({ clearMissing: false });

    expect(changed).toBe(false);
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-deployment");
  });

  it("clears missing known env vars by default", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-old";
    fs.writeFileSync(envFilePath, "");
    const { reloadEnv } = require("../../lib/server/env");

    const changed = reloadEnv();

    expect(changed).toBe(true);
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("writes a newline-terminated file that reads back unchanged", () => {
    const { readEnvFile, writeEnvFile } = require("../../lib/server/env");
    const vars = [
      { key: "CUSTOM_FLAG", value: "1" },
      { key: "OPENCLAW_GATEWAY_TOKEN", value: "gw-token" },
    ];

    writeEnvFile(vars);

    expect(fs.readFileSync(envFilePath, "utf8")).toBe(
      "CUSTOM_FLAG=1\nOPENCLAW_GATEWAY_TOKEN=gw-token\n",
    );
    expect(readEnvFile()).toEqual(vars);
  });
});
