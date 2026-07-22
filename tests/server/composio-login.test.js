const { EventEmitter } = require("events");
const {
  kStartCommand,
  extractLoginUrl,
  createComposioLoginService,
} = require("../../lib/server/composio-login");

// Real output captured from @composio/cli 0.2.32 `login --no-browser --no-wait`
const kRealStartOutput = [
  "Open this URL in your browser to log in:",
  "",
  "  https://dashboard.composio.dev/?cliKey=eae6f42e-6aa3-456d-9304-c5c52ab744e8",
  "",
  "Then run this command to complete login:",
  "",
  "  composio login --poll",
].join("\n");

describe("server/composio-login", () => {
  it("extracts the login URL from real CLI output", () => {
    expect(extractLoginUrl(kRealStartOutput)).toBe(
      "https://dashboard.composio.dev/?cliKey=eae6f42e-6aa3-456d-9304-c5c52ab744e8",
    );
    expect(extractLoginUrl("no url here")).toBe("");
  });

  const createHarness = ({ startOutput = kRealStartOutput } = {}) => {
    const children = [];
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter();
      child.pid = 5000 + children.length;
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => child.emit("exit", null, "SIGTERM"));
      children.push(child);
      return child;
    });
    const composioCmd = vi.fn(async () => ({
      ok: true,
      stdout: startOutput,
      stderr: "",
    }));
    const onLoginComplete = vi.fn();
    const service = createComposioLoginService({
      composioCmd,
      onLoginComplete,
      spawnFn,
      homedir: "/home/test",
      now: () => 1784800000000,
    });
    return { service, spawnFn, composioCmd, onLoginComplete, children };
  };

  it("start returns the login URL and begins polling", async () => {
    const { service, spawnFn, composioCmd } = createHarness();

    const result = await service.start();

    expect(composioCmd).toHaveBeenCalledWith(kStartCommand, {
      quiet: true,
      timeoutMs: 30000,
    });
    expect(result.loginUrl).toContain("dashboard.composio.dev/?cliKey=");
    expect(spawnFn).toHaveBeenCalledWith(
      "composio",
      ["login", "--poll"],
      expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
    );
    expect(service.isPending()).toBe(true);
    service.stop();
  });

  it("invokes onLoginComplete when the poll succeeds", async () => {
    const { service, onLoginComplete, children } = createHarness();
    await service.start();

    children[0].emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onLoginComplete).toHaveBeenCalled();
    expect(service.isPending()).toBe(false);
    expect(service.getError()).toBe("");
  });

  it("records an error when the poll fails", async () => {
    const { service, onLoginComplete, children } = createHarness();
    await service.start();

    children[0].stderr.emit("data", "login key expired");
    children[0].emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onLoginComplete).not.toHaveBeenCalled();
    expect(service.getError()).toContain("login key expired");
    expect(service.isPending()).toBe(false);
  });

  it("replaces a stale poll when start is called again", async () => {
    const { service, children } = createHarness();
    await service.start();
    await service.start();

    expect(children).toHaveLength(2);
    expect(children[0].kill).toHaveBeenCalled();
    // The first child's SIGTERM-driven exit must not clear the new poll
    expect(service.isPending()).toBe(true);
    service.stop();
  });

  it("throws with CLI detail when no URL is returned", async () => {
    const { service, spawnFn } = createHarness({
      startOutput: "You are not logged in yet. Please run `composio login`.",
    });

    await expect(service.start()).rejects.toThrow(/not logged in/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
