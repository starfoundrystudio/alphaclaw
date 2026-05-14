const childProcess = require("child_process");

const modulePath = require.resolve("../../lib/server/commands");
const originalExec = childProcess.exec;

const loadCommandsModule = ({ execMock = originalExec } = {}) => {
  childProcess.exec = execMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

describe("server/commands", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
  });

  it("redacts secret-bearing onboarding flags in command logs", () => {
    const { sanitizeOnboardCommandForLog } = loadCommandsModule();
    const sanitized = sanitizeOnboardCommandForLog(
      'openclaw onboard "--gateway-token" "gw-secret" "--ai-gateway-api-key" "vck_live_secret" "--client-secret" "plain-secret" "--workspace" "/tmp/workspace"',
    );

    expect(sanitized).toContain('"--gateway-token" "***"');
    expect(sanitized).toContain('"--ai-gateway-api-key" "***"');
    expect(sanitized).toContain('"--client-secret" "***"');
    expect(sanitized).toContain('"--workspace" "/tmp/workspace"');
    expect(sanitized).not.toContain("gw-secret");
    expect(sanitized).not.toContain("vck_live_secret");
    expect(sanitized).not.toContain("plain-secret");
  });

  it("redacts known token prefixes even outside secret-looking flags", () => {
    const { sanitizeOnboardCommandForLog } = loadCommandsModule();
    const sanitized = sanitizeOnboardCommandForLog(
      "echo ghp_secret github_pat_secret sk-secret vck_secret",
    );

    expect(sanitized).not.toContain("ghp_secret");
    expect(sanitized).not.toContain("github_pat_secret");
    expect(sanitized).not.toContain("sk-secret");
    expect(sanitized).not.toContain("vck_secret");
    expect(sanitized).toContain("***");
  });

  it("attaches trimmed stdout and stderr to shellCmd errors", async () => {
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(new Error("boom"), ' {"ok":true} \n', " noisy stderr \n");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { shellCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    await expect(shellCmd("openclaw models list --all --json")).rejects.toMatchObject({
      message: "boom",
      stdout: '{"ok":true}',
      stderr: "noisy stderr",
      cmd: "openclaw models list --all --json",
    });
  });

  it("preserves timeout metadata on clawCmd failures", async () => {
    const timeoutError = Object.assign(new Error("Command failed"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(timeoutError, "", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { clawCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    const result = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: 1234,
    });

    expect(execMock).toHaveBeenCalledWith(
      "openclaw nodes status --json",
      expect.objectContaining({
        timeout: 1234,
        killSignal: "SIGTERM",
      }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      killed: true,
      signal: "SIGTERM",
      timedOut: true,
    });
  });
});
