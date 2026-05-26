const fs = require("fs");
const os = require("os");
const path = require("path");

describe("server/env", () => {
  let tmpDir;
  let envFilePath;
  let previousSlackToken;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-"));
    envFilePath = path.join(tmpDir, ".env");
    previousSlackToken = process.env.SLACK_BOT_TOKEN;
    vi.resetModules();
    vi.doMock("../../lib/server/constants", () => ({
      ENV_FILE_PATH: envFilePath,
      kKnownVars: [{ key: "SLACK_BOT_TOKEN" }],
    }));
  });

  afterEach(() => {
    if (previousSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = previousSlackToken;
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
});
