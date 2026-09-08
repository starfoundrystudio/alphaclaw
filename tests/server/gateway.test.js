const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const {
  ALPHACLAW_DIR,
  kOnboardingMarkerPath,
  OPENCLAW_DIR,
} = require("../../lib/server/constants");
const {
  kDefaultOpenclawCompileCacheDir,
} = require("../../lib/server/openclaw-runtime-env");

const kLegacyControlUiSkillPath = path.join(OPENCLAW_DIR, "skills", "control-ui", "SKILL.md");
const kAlphaclawConfigPath = path.join(OPENCLAW_DIR, "alphaclaw.json");

const modulePath = require.resolve("../../lib/server/gateway");
const originalSpawn = childProcess.spawn;
const originalExecSync = childProcess.execSync;
const originalExistsSync = fs.existsSync;
const originalMkdirSync = fs.mkdirSync;
const originalReaddirSync = fs.readdirSync;
const originalReadFileSync = fs.readFileSync;
const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;
const originalWriteFileSync = fs.writeFileSync;
const originalCreateConnection = net.createConnection;

const createSocket = (isRunning) => {
  const running =
    typeof isRunning === "function" ? isRunning() : isRunning;
  return {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    on(event, handler) {
      if (running && event === "connect") {
        setImmediate(handler);
      }
      if (!running && event === "error") {
        setImmediate(handler);
      }
      return this;
    },
  };
};

const createChild = (pid = 1234, { announcesReady = true } = {}) => ({
  pid,
  stdout: { on: vi.fn((event, handler) => {
    const args = childProcess.spawn.mock?.calls.at(-1)?.[1];
    if (announcesReady && event === "data" && args?.includes("--force")) {
      setImmediate(() => handler("http server listening (3 plugins; 7.0s)"));
    }
  }) },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
  killed: false,
});

describe("server/gateway restart behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
    childProcess.spawn = originalSpawn;
    childProcess.execSync = originalExecSync;
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
    fs.renameSync = originalRenameSync;
    fs.rmSync = originalRmSync;
    fs.writeFileSync = originalWriteFileSync;
    net.createConnection = originalCreateConnection;
    delete require.cache[modulePath];
  });

  it("always cold-starts when the gateway port is listening", async () => {
    const managedChild = createChild();
    const restartSupervisor = createChild();
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(managedChild)
      .mockReturnValueOnce(restartSupervisor);
    const execSyncMock = vi.fn(() => "");
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    let gatewayPortOpen = false;
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    await gateway.startGateway();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    gatewayPortOpen = true;
    const reloadEnv = vi.fn();
    await gateway.restartGateway(reloadEnv);

    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway restart",
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "openclaw",
      ["gateway", "--force"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(managedChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("exports the durable OpenClaw state dir in gateway env", () => {
    const previousCompileCache = process.env.NODE_COMPILE_CACHE;
    const previousNoRespawn = process.env.OPENCLAW_NO_RESPAWN;
    const previousHome = process.env.HOME;
    delete process.env.NODE_COMPILE_CACHE;
    delete process.env.OPENCLAW_NO_RESPAWN;
    process.env.HOME = "/home/alphaclaw";
    try {
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.gatewayEnv()).toEqual(
        expect.objectContaining({
          HOME: expect.any(String),
          OPENCLAW_HOME: expect.any(String),
          OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
          OPENCLAW_STATE_DIR: OPENCLAW_DIR,
          XDG_CONFIG_HOME: OPENCLAW_DIR,
          NODE_COMPILE_CACHE: kDefaultOpenclawCompileCacheDir,
          OPENCLAW_NO_RESPAWN: "1",
        }),
      );
      expect(gateway.gatewayEnv().HOME).toBe("/home/alphaclaw");
      expect(gateway.gatewayEnv().OPENCLAW_HOME).toBe(ALPHACLAW_DIR);
      expect(gateway.gatewayEnv().HOME).not.toBe(gateway.gatewayEnv().OPENCLAW_HOME);
    } finally {
      if (previousCompileCache === undefined) {
        delete process.env.NODE_COMPILE_CACHE;
      } else {
        process.env.NODE_COMPILE_CACHE = previousCompileCache;
      }
      if (previousNoRespawn === undefined) {
        delete process.env.OPENCLAW_NO_RESPAWN;
      } else {
        process.env.OPENCLAW_NO_RESPAWN = previousNoRespawn;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("uses force cold start when the gateway port is not listening", async () => {
    const restartSupervisor = createChild();
    const spawnMock = vi.fn(() => restartSupervisor);
    const execSyncMock = vi.fn(() => "");
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    let gatewayPortOpen = false;
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    const reloadEnv = vi.fn();
    const restartPromise = gateway.restartGateway(reloadEnv);
    gatewayPortOpen = true;
    await restartPromise;

    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway restart",
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "openclaw",
      ["gateway", "--force"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway --force",
      expect.anything(),
    );
  });

  it("retries channel plugin preflight after cleaning stale install stages", () => {
    const firstError = new Error(
      "ENOTEMPTY: directory not empty, rmdir '/srv/alphaclaw/node_modules/openclaw/dist/extensions/telegram/.openclaw-install-stage/node_modules/typebox/build/type/engine'",
    );
    const execSyncMock = vi
      .fn()
      .mockImplementationOnce(() => {
        throw firstError;
      })
      .mockReturnValueOnce("{}");
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: true },
          },
        });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    let stagePresent = true;
    fs.readdirSync = vi.fn((targetPath) => {
      if (String(targetPath).endsWith("/dist/extensions")) {
        return [{ name: "telegram", isDirectory: () => true }];
      }
      if (String(targetPath).endsWith("/dist/extensions/telegram")) {
        return [
          ...(stagePresent
            ? [{ name: ".openclaw-install-stage", isDirectory: () => true }]
            : []),
          { name: "node_modules", isDirectory: () => true },
        ];
      }
      return [];
    });
    fs.rmSync = vi.fn(() => {
      stagePresent = false;
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    gateway.prepareOpenclawChannelPlugins();

    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock).toHaveBeenNthCalledWith(1, "openclaw plugins list --json", {
      env: expect.any(Object),
      timeout: 120000,
      encoding: "utf8",
    });
    expect(execSyncMock).toHaveBeenNthCalledWith(2, "openclaw plugins list --json", {
      env: expect.any(Object),
      timeout: 120000,
      encoding: "utf8",
    });
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("/telegram/.openclaw-install-stage"),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("marks managed child exit as expected before relaunch", async () => {
    const child = createChild();
    const spawnMock = vi.fn(() => child);
    const execSyncMock = vi.fn(() => "");
    const exitHandler = vi.fn();
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    let gatewayPortOpen = false;
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    gateway.setGatewayExitHandler(exitHandler);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    await gateway.startGateway();
    const restartPromise = gateway.restartGateway(vi.fn());
    gatewayPortOpen = true;
    await restartPromise;

    const exitRegistration = child.on.mock.calls.find((call) => call[0] === "exit");
    expect(exitRegistration).toBeTruthy();

    const [, onExit] = exitRegistration;
    onExit(0, null);

    expect(exitHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 0,
        signal: null,
        expectedExit: true,
      }),
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("shuts down an owned gateway child without invoking the OpenClaw CLI", () => {
    const child = createChild();
    const spawnMock = vi.fn(() => child);
    const execSyncMock = vi.fn(() => "");
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => false);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const exitProcess = vi.fn();

    gateway.launchGatewayProcess();
    const handleSignal = gateway.createGatewaySignalHandler({ exitProcess });
    handleSignal();
    handleSignal();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("shuts down cleanly without an owned gateway child or OpenClaw CLI call", () => {
    const execSyncMock = vi.fn(() => "");
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => false);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const exitProcess = vi.fn();

    gateway.createGatewaySignalHandler({ exitProcess })();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("delays and retries an initial launch blocked by the migration lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T22:13:30.000Z"));
    const firstChild = createChild(1234);
    const retryChild = createChild(5678);
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(retryChild);
    childProcess.spawn = spawnMock;
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(false));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const exitHandler = vi.fn();
    gateway.setGatewayExitHandler(exitHandler);

    gateway.launchGatewayProcess();
    const [, onStderr] = firstChild.stderr.on.mock.calls.find(
      ([event]) => event === "data",
    );
    onStderr(
      Buffer.from(
        "OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 2026-08-28T22:13:40.000Z.\n",
      ),
    );
    const [, onExit] = firstChild.on.mock.calls.find(
      ([event]) => event === "exit",
    );
    onExit(1, null);

    expect(exitHandler).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1, expectedExit: true, expectedExitReason: "migration_retry", recoveryWindowMs: 133000 }),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_999);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith(
      "openclaw",
      ["gateway", "run"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it("keeps one restart owner through migration backoff and tracks its recovered child", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T17:41:00Z"));
    const first = createChild(101);
    const second = createChild(102);
    const spawnMock = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    childProcess.spawn = spawnMock;
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    let running = false;
    net.createConnection = vi.fn(() => createSocket(() => running));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const exits = vi.fn();
    gateway.setGatewayExitHandler(exits);
    const restart = gateway.restartGateway(vi.fn());
    const anotherRestart = gateway.restartGateway(vi.fn());
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    first.stderr.on.mock.calls.find(([event]) => event === "data")[1](
      "OpenClaw startup migrations are already running; retry after 2026-09-08T17:46:00.000Z.");
    first.exitCode = 1;
    first.on.mock.calls.find(([event]) => event === "exit")[1](1, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(exits).toHaveBeenCalledWith(expect.objectContaining({ expectedExitReason: "migration_retry" }));
    expect(gateway.launchGatewayProcess()).toBe(null);
    await vi.advanceTimersByTimeAsync(302000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    running = true;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([restart, anotherRestart]);
    expect(gateway.hasActiveManagedGatewayChild()).toBe(true);
    gateway.launchGatewayProcess();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not kill a gateway still completing its initial migrations", async () => {
    vi.useFakeTimers();
    const first = createChild(101);
    const second = createChild(102);
    childProcess.spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    let running = false;
    net.createConnection = vi.fn(() => createSocket(() => running));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    gateway.launchGatewayProcess();
    const restart = gateway.restartGateway(vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.kill).not.toHaveBeenCalled();
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    running = true;
    await vi.advanceTimersByTimeAsync(1000);
    await restart;
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  it("applies a configuration change requested after the current restart spawned", async () => {
    vi.useFakeTimers();
    childProcess.spawn = vi.fn().mockImplementation(() => createChild(100 + childProcess.spawn.mock.calls.length));
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    let running = false;
    net.createConnection = vi.fn(() => createSocket(() => running));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const first = gateway.restartGateway(vi.fn());
    await Promise.resolve();
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const laterChange = gateway.restartGateway(vi.fn());
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    running = true;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, laterChange]);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  it("replaces a hung initial child after the bounded startup window", async () => {
    vi.useFakeTimers();
    const first = createChild(101);
    let running = false;
    childProcess.spawn = vi.fn().mockReturnValueOnce(first).mockImplementation(() => {
      running = true;
      return createChild(102);
    });
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(() => running));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    gateway.launchGatewayProcess();
    await vi.advanceTimersByTimeAsync(10000);
    const restart = gateway.restartGateway(vi.fn());
    await vi.advanceTimersByTimeAsync(109000);
    expect(first.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await restart;
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not grant a new startup window to a previously listening child", async () => {
    const first = createChild(101);
    let running = false;
    childProcess.spawn = vi.fn().mockReturnValueOnce(first).mockImplementation(() => {
      running = true;
      return createChild(102);
    });
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(() => running));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    gateway.setGatewayLaunchHandler(vi.fn());
    gateway.launchGatewayProcess();
    first.stdout.on.mock.calls.find(([event]) => event === "data")[1]("listening on ws://127.0.0.1:18789");
    await gateway.restartGateway(vi.fn());
    expect(first.kill).toHaveBeenCalledTimes(1);
  });

  it("cannot mistake an outgoing listener for the replacement's readiness", async () => {
    vi.useFakeTimers();
    const child = createChild(101, { announcesReady: false });
    childProcess.spawn = vi.fn(() => child);
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(true));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    let completed = false;
    const restart = gateway.restartGateway(vi.fn()).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(completed).toBe(false);
    expect(gateway.isGatewayLifecycleBusy()).toBe(true);
    const onData = child.stdout.on.mock.calls.find(([event]) => event === "data")[1];
    onData("another gateway instance is already listening on ws://127.0.0.1:18789");
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    onData("http server listening (3 plugins; 7.0s)");
    await vi.advanceTimersByTimeAsync(1000);
    await restart;
    expect(completed).toBe(true);
    expect(gateway.isGatewayLifecycleBusy()).toBe(false);
  });

  it("recognizes the pinned OpenClaw startup log even across chunks", () => {
    const child = createChild(101);
    childProcess.spawn = vi.fn(() => child);
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const ready = vi.fn();
    gateway.setGatewayLaunchHandler(ready);
    gateway.launchGatewayProcess();
    expect(gateway.isGatewayLifecycleBusy()).toBe(true);
    const onData = child.stderr.on.mock.calls.find(([event]) => event === "data")[1];
    onData("http server list");
    onData("ening (3 plugins; 7.0s)");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(gateway.isGatewayLifecycleBusy()).toBe(false);
  });

  it("queues a cold restart behind Doctor and permits only the repair owner's launch", async () => {
    const doctorChild = createChild(101);
    const replacement = createChild(102);
    childProcess.spawn = vi.fn().mockReturnValueOnce(doctorChild).mockReturnValueOnce(replacement);
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(true));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const lifecycleOwner = gateway.tryAcquireGatewayRepair();
    expect(lifecycleOwner).toBeTruthy();
    const restart = gateway.restartGateway(vi.fn());
    await Promise.resolve();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(gateway.launchGatewayProcess()).toBe(null);
    expect(gateway.launchGatewayProcess({ lifecycleOwner })).toBe(doctorChild);
    doctorChild.stdout.on.mock.calls.find(([event]) => event === "data")[1]("http server listening (3 plugins; 7.0s)");
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    lifecycleOwner.release();
    await restart;
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    expect(gateway.isGatewayLifecycleBusy()).toBe(false);
  });

  it("keeps startup evidence enabled when the operator suppresses info logs", () => {
    const previous = process.env.OPENCLAW_LOG_LEVEL;
    try {
      process.env.OPENCLAW_LOG_LEVEL = "warn";
      childProcess.spawn = vi.fn(() => createChild(101));
      childProcess.execSync = vi.fn(() => "");
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      gateway.launchGatewayProcess();
      expect(childProcess.spawn.mock.calls[0][2].env.OPENCLAW_LOG_LEVEL).toBe("info");
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_LOG_LEVEL;
      else process.env.OPENCLAW_LOG_LEVEL = previous;
    }
  });

  it("does not treat auth-only openclaw config as onboarded", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        auth: {
          profiles: {
            "openai:codex-cli": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
      }),
    );

    expect(gateway.isOnboarded()).toBe(false);
  });

  it("treats onboarding marker as source of truth", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(true);
  });

  it("does not backfill onboarding marker from config with primary model", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.3-codex",
            },
          },
        },
      }),
    );

    expect(gateway.isOnboarded()).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not treat nested openclaw config as onboarded", () => {
    fs.existsSync = vi.fn(
      (targetPath) => targetPath === `${OPENCLAW_DIR}/.openclaw/openclaw.json`,
    );
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("backfills onboarding marker from legacy onboarding artifact", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === kLegacyControlUiSkillPath);
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      kOnboardingMarkerPath,
      expect.stringContaining('"reason": "legacy_artifact_backfill"'),
    );
  });

  it("adds the setup origin to gateway control UI config", () => {
    let currentConfig = {
      gateway: { mode: "local" },
    };
    let pendingConfigContent = "";
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (String(targetPath).includes("openclaw.json.alphaclaw-")) {
        pendingConfigContent = contents;
      }
    });
    fs.renameSync = vi.fn((fromPath, toPath) => {
      if (toPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(pendingConfigContent);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      return "{}";
    });

    const changed = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(changed).toBe(true);
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("openclaw.json.alphaclaw-"),
      `${OPENCLAW_DIR}/openclaw.json`,
    );
    expect(currentConfig.gateway.trustedProxies).toEqual(["127.0.0.1"]);
    expect(currentConfig.gateway.controlUi.allowedOrigins).toEqual([
      "https://setup.example.com",
    ]);
    expect(currentConfig.gateway.http).toBeUndefined();
  });

  it("preserves existing allowed origins and remains idempotent", () => {
    let currentConfig = {
      gateway: {
        mode: "local",
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: ["https://existing.example.com"],
        },
      },
    };
    let pendingConfigContent = "";
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (String(targetPath).includes("openclaw.json.alphaclaw-")) {
        pendingConfigContent = contents;
      }
    });
    fs.renameSync = vi.fn((fromPath, toPath) => {
      if (toPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(pendingConfigContent);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      return "{}";
    });

    const firstChanged = gateway.ensureGatewayProxyConfig("https://setup.example.com");
    const secondChanged = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(firstChanged).toBe(true);
    expect(secondChanged).toBe(false);
    expect(currentConfig.gateway.controlUi.allowedOrigins).toEqual([
      "https://existing.example.com",
      "https://setup.example.com",
    ]);
    expect(currentConfig.gateway.http).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
  });

  it("does not mutate gateway proxy config when gateway.mode is missing", () => {
    const currentConfig = {
      gateway: {},
    };
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn();
    fs.renameSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      return "{}";
    });

    expect(gateway.ensureGatewayProxyConfig("https://setup.example.com")).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it("preserves existing gateway endpoint options while enabling opted-in public API endpoints", () => {
    let currentConfig = {
      gateway: {
        mode: "local",
        trustedProxies: ["127.0.0.1"],
        http: {
          endpoints: {
            chatCompletions: {
              maxBodyBytes: 12345,
            },
            responses: {
              maxBodyBytes: 67890,
            },
          },
        },
        controlUi: {
          allowedOrigins: ["https://setup.example.com"],
        },
      },
    };
    let pendingConfigContent = "";
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (String(targetPath).includes("openclaw.json.alphaclaw-")) {
        pendingConfigContent = contents;
      }
    });
    fs.renameSync = vi.fn((fromPath, toPath) => {
      if (toPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(pendingConfigContent);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      if (targetPath === kAlphaclawConfigPath) {
        return JSON.stringify({
          features: { openaiCompatApi: { enabled: true } },
        });
      }
      return "{}";
    });

    const changed = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(changed).toBe(true);
    expect(currentConfig.gateway.http.endpoints.chatCompletions).toEqual({
      enabled: true,
      maxBodyBytes: 12345,
    });
    expect(currentConfig.gateway.http.endpoints.responses).toEqual({
      enabled: true,
      maxBodyBytes: 67890,
    });
  });

  describe("Managed remote MCP server config", () => {
    const kRemoteMcpEnvKeys = [
      "REMOTE_MCP_URL",
      "REMOTE_MCP_API_TOKEN",
      "REMOTE_MCP_PROXY_URL",
      "REMOTE_MCP_NAME",
    ];

    const withEnv = (vars, fn) => {
      const prev = {};
      for (const key of kRemoteMcpEnvKeys) prev[key] = process.env[key];
      try {
        for (const [key, value] of Object.entries(vars)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        return fn();
      } finally {
        for (const key of kRemoteMcpEnvKeys) {
          if (prev[key] === undefined) delete process.env[key];
          else process.env[key] = prev[key];
        }
      }
    };

    const setupConfigIo = (initial) => {
      let currentConfig = {
        ...initial,
        gateway: {
          mode: "local",
          ...(initial.gateway || {}),
        },
      };
      let lastRawContents = null;
      fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
      fs.writeFileSync = vi.fn((targetPath, contents) => {
        if (String(targetPath).includes("openclaw.json.alphaclaw-")) {
          lastRawContents = contents;
        }
      });
      fs.renameSync = vi.fn((fromPath, toPath) => {
        if (toPath === `${OPENCLAW_DIR}/openclaw.json`) {
          const contents = lastRawContents || "{}";
          currentConfig = JSON.parse(contents);
        }
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn((targetPath) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify(currentConfig);
        }
        return "{}";
      });
      return {
        gateway,
        getConfig: () => currentConfig,
        getRawContents: () => lastRawContents,
      };
    };

    it("writes remote MCP server with placeholder when env vars are set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toEqual({
            url: "https://sure.example.com/mcp",
            transport: "streamable-http",
            headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
            _alphaclawManaged: true,
          });
          expect(io.getRawContents()).not.toContain("sk-sure-secret-token");
          expect(io.getRawContents()).toContain("Bearer ${REMOTE_MCP_API_TOKEN}");
        },
      );
    });

    it("routes through REMOTE_MCP_PROXY_URL when set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: "http://127.0.0.1:8889/mcp",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "http://127.0.0.1:8889/mcp",
          );
          expect(io.getConfig().mcp.servers.remote.headers.Authorization).toBe(
            "Bearer ${REMOTE_MCP_API_TOKEN}",
          );
        },
      );
    });

    it("removes existing remote MCP server when env vars unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: undefined,
          REMOTE_MCP_API_TOKEN: undefined,
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                remote: {
                  url: "https://old.example.com/mcp",
                  transport: "streamable-http",
                  headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
                  _alphaclawManaged: true,
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp).toBeUndefined();
        },
      );
    });

    it("preserves an unmarked user remote MCP server when env vars are unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: undefined,
          REMOTE_MCP_API_TOKEN: undefined,
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                remote: {
                  url: "https://user.example.com/mcp",
                  transport: "sse",
                  headers: { Authorization: "Bearer user-token" },
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toEqual({
            url: "https://user.example.com/mcp",
            transport: "sse",
            headers: { Authorization: "Bearer user-token" },
          });
        },
      );
    });

    it("uses REMOTE_MCP_NAME as the server key when set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "sure",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.sure).toBeDefined();
          expect(io.getConfig().mcp.servers.remote).toBeUndefined();
          expect(io.getConfig().mcp.servers.sure.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });

    it("is idempotent when remote MCP server already matches", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: "http://127.0.0.1:8889/mcp",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const firstChanged = io.gateway.ensureGatewayProxyConfig(undefined);
          const secondChanged = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(firstChanged).toBe(true);
          expect(secondChanged).toBe(false);
          expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        },
      );
    });

    it("uses REMOTE_MCP_URL directly when REMOTE_MCP_PROXY_URL is unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });

    it("scrubs an existing plaintext Authorization back to the placeholder reference", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          PIPELOCK_ENABLED: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                sure: {
                  url: "https://sure.example.com/mcp",
                  transport: "streamable-http",
                  headers: {
                    Authorization: "Bearer sk-sure-secret-token",
                  },
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.headers.Authorization).toBe(
            "Bearer ${REMOTE_MCP_API_TOKEN}",
          );
          expect(io.getRawContents()).not.toContain("sk-sure-secret-token");
        },
      );
    });

    it("removes the prior managed entry when REMOTE_MCP_NAME changes", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "notion",
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                sure: {
                  url: "https://old.example.com/mcp",
                  transport: "streamable-http",
                  headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
                  _alphaclawManaged: true,
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.sure).toBeUndefined();
          expect(io.getConfig().mcp.servers.notion).toBeDefined();
          expect(io.getConfig().mcp.servers.notion._alphaclawManaged).toBe(true);
        },
      );
    });

    it("does not touch unmarked user entries when REMOTE_MCP_NAME differs", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "notion",
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                "user-server": {
                  url: "https://user.example.com/mcp",
                  transport: "sse",
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers["user-server"]).toEqual({
            url: "https://user.example.com/mcp",
            transport: "sse",
          });
          expect(io.getConfig().mcp.servers.notion._alphaclawManaged).toBe(true);
        },
      );
    });

    it.each([
      ["__proto__"],
      ["constructor"],
      ["prototype"],
      ["has spaces"],
      ["path/like"],
      ["dot.notation"],
      [""],
    ])("rejects invalid REMOTE_MCP_NAME %j and falls back to default", (badName) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: badName === "" ? undefined : badName,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toBeDefined();
          expect(Object.keys(io.getConfig().mcp.servers)).not.toContain(badName);
          // Empty REMOTE_MCP_NAME is a normal default, not a warning.
          if (badName) {
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining("REMOTE_MCP_NAME"),
            );
          }
        },
      );
      warnSpy.mockRestore();
    });

    it("preserves unrelated mcp.servers entries when the remote config changes", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                other: {
                  url: "https://other.example.com/mcp",
                  transport: "sse",
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.other).toEqual({
            url: "https://other.example.com/mcp",
            transport: "sse",
          });
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });
  });

  it("reports channel status per account while preserving provider summary", () => {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/credentials`) {
        return ["telegram-default-allowFrom.json", "telegram-alerts-allowFrom.json"];
      }
      return [];
    });
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              accounts: {
                default: { botToken: "${TELEGRAM_BOT_TOKEN}" },
                alerts: { botToken: "${TELEGRAM_BOT_TOKEN_ALERTS}" },
              },
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-default-allowFrom.json`) {
        return JSON.stringify({ allowFrom: ["1001"] });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-alerts-allowFrom.json`) {
        return JSON.stringify({ allowFrom: [] });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      telegram: {
        status: "paired",
        paired: 1,
        accounts: {
          default: { status: "paired", paired: 1 },
          alerts: { status: "configured", paired: 0 },
        },
      },
    });
  });

  it("treats legacy single-account telegram config as default account status", () => {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/credentials`) {
        return ["telegram-allowFrom.json"];
      }
      return [];
    });
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: "${TELEGRAM_BOT_TOKEN}",
              dmPolicy: "pairing",
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-allowFrom.json`) {
        return JSON.stringify({ allowFrom: ["1001", "1002"] });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      telegram: {
        status: "paired",
        paired: 2,
        accounts: {
          default: { status: "paired", paired: 2 },
        },
      },
    });
  });

  it("treats whatsapp owner-number self chat as paired when saved creds exist", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn(() => []);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            whatsapp: {
              enabled: true,
              accounts: {
                default: {
                  name: "WhatsApp",
                  dmPolicy: "pairing",
                },
              },
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
        return "{}";
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      whatsapp: {
        status: "paired",
        paired: 1,
        accounts: {
          default: { status: "paired", paired: 1 },
        },
      },
    });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("keeps whatsapp configured when owner number exists but saved creds do not", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    dmPolicy: "pairing",
                  },
                },
              },
            },
          });
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "configured",
          paired: 0,
          accounts: {
            default: { status: "configured", paired: 0 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("does not treat whatsapp allowFrom owner placeholder as paired without saved creds", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    groupAllowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    dmPolicy: "allowlist",
                    groupPolicy: "allowlist",
                    selfChatMode: true,
                  },
                },
              },
            },
          });
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "configured",
          paired: 0,
          accounts: {
            default: { status: "configured", paired: 0 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("treats whatsapp allowFrom owner placeholder as paired when saved creds exist", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    groupAllowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    dmPolicy: "allowlist",
                    groupPolicy: "allowlist",
                    selfChatMode: true,
                  },
                },
              },
            },
          });
        }
        if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
          return "{}";
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "paired",
          paired: 1,
          accounts: {
            default: { status: "paired", paired: 1 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });
});

describe("server/gateway parseMigrationLockRetryAfterMs", () => {
  const {
    getMigrationLockRetryDelayMs,
    parseMigrationLockRetryAfterMs,
  } = require("../../lib/server/gateway");

  it("extracts the retry-after timestamp from the real lock message", () => {
    const output = [
      "[openclaw] Could not start the CLI.",
      "[openclaw] Reason: OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 2026-08-26T18:25:02.345Z.",
      "[openclaw] Try: openclaw doctor",
    ].join("\n");
    expect(parseMigrationLockRetryAfterMs(output)).toBe(
      Date.parse("2026-08-26T18:25:02.345Z"),
    );
  });

  it("returns null for unrelated output", () => {
    expect(parseMigrationLockRetryAfterMs("Gateway service disabled.")).toBe(null);
    expect(parseMigrationLockRetryAfterMs("")).toBe(null);
    expect(parseMigrationLockRetryAfterMs(null)).toBe(null);
  });

  it("bounds migration-lock delays and includes a post-expiry grace period", () => {
    const output =
      "OpenClaw startup migrations are already running; retry after the other gateway finishes or after 2026-08-28T22:13:40.000Z.";

    expect(
      getMigrationLockRetryDelayMs(output, {
        nowMs: Date.parse("2026-08-28T22:13:30.000Z"),
      }),
    ).toBe(13_000);
    expect(
      getMigrationLockRetryDelayMs(output, {
        nowMs: Date.parse("2026-08-28T22:00:00.000Z"),
      }),
    ).toBe(null);
  });
});
