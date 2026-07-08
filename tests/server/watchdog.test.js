const { createWatchdog } = require("../../lib/server/watchdog");

const kGuardedDoctorRepairCommand =
  "alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix";
const kExpectedRepairCommandArgs = {
  timeoutMs: 600000,
  env: expect.objectContaining({
    ALPHACLAW_ROOT_DIR: "/tmp/alphaclaw",
    OPENCLAW_HOME: "/tmp/alphaclaw",
    OPENCLAW_CONFIG_PATH: "/tmp/alphaclaw/.openclaw/openclaw.json",
    OPENCLAW_STATE_DIR: "/tmp/alphaclaw/.openclaw",
    XDG_CONFIG_HOME: "/tmp/alphaclaw/.openclaw",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  }),
};

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

const createHarness = ({
  autoRepair = true,
  notificationsDisabled = false,
  clawCmdImpl,
  shellCmdImpl,
  resolveSetupUrl = () => "https://setup.example.com",
  resolveGatewayHealthUrl = () => "http://127.0.0.1:18789/health",
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, status: "live" }),
  }),
  eventLoopLagMonitor = {
    sample: vi.fn(() => ({ p95Ms: 0, maxMs: 0, meanMs: 0 })),
    stop: vi.fn(),
  },
  reconcileOpenclawPlugins,
  openclawConfig = { gateway: { mode: "local" } },
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = notificationsDisabled ? "true" : "false";

  const insertWatchdogEvent = vi.fn();
  const clawCmd = vi.fn(
    clawCmdImpl ||
      (async () => ({
        ok: true,
        stdout: JSON.stringify({ ok: true }),
      })),
  );
  const shellCmd = vi.fn(shellCmdImpl || (async () => "fixed"));
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const readEnvFile = vi.fn(() => []);
  const writeEnvFile = vi.fn();
  const reloadEnv = vi.fn();
  const fsModule = {
    readFileSync: vi.fn(() => JSON.stringify(openclawConfig)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  global.fetch = vi.fn(fetchImpl);

  const watchdog = createWatchdog({
    clawCmd,
    shellCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    resolveSetupUrl,
    resolveGatewayHealthUrl,
    reconcileOpenclawPlugins,
    rootDir: "/tmp/alphaclaw",
    openclawDir: "/tmp/alphaclaw/.openclaw",
    fsModule,
    reconcileLogger: { log: vi.fn() },
    eventLoopLagMonitor,
  });

  return {
    watchdog,
    insertWatchdogEvent,
    shellCmd,
    clawCmd,
    notifier,
    launchGatewayProcess,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    reconcileOpenclawPlugins,
    fsModule,
    eventLoopLagMonitor,
  };
};

describe("server/watchdog", () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) {
      delete process.env.WATCHDOG_AUTO_REPAIR;
    } else {
      process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    }
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    }
    if (kOriginalFetch == null) {
      delete global.fetch;
    } else {
      global.fetch = kOriginalFetch;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs startup-grace health failures as skipped ok events", async () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });

    watchdog.start();
    await flushMicrotasks();

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          startupGraceActive: true,
        }),
      }),
    );
    watchdog.stop();
  });

  it("keeps slow-start gateways in startup grace for the default 60s window", async () => {
    vi.useFakeTimers();
    const { watchdog, shellCmd } = createHarness({
      autoRepair: true,
      clawCmdImpl: async () => ({ ok: true, stdout: "" }),
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 35_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
      }),
    );
    expect(shellCmd).not.toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    watchdog.stop();
  });

  it("retries startup health checks before marking degraded", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, shellCmd, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("gateway unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("unknown");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(shellCmd).not.toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          startupFailureRetryActive: true,
          startupConsecutiveFailures: 1,
          startupFailureThreshold: 3,
        }),
      }),
    );
    watchdog.stop();
  });

  it("uses 5s degraded retries to recover before regular interval", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog } = createHarness({
      autoRepair: false,
      clawCmdImpl: async () => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks <= 3) {
          throw new Error("temporarily unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.getStatus().health).toBe("degraded");
    expect(healthChecks).toBe(3);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(healthChecks).toBe(4);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    watchdog.stop();
  });

  it("suppresses probe failures and auto-repair when AlphaClaw event-loop lag is high", async () => {
    vi.useFakeTimers();
    const eventLoopLagMonitor = {
      sample: vi.fn(() => ({ p95Ms: 1500, maxMs: 4000, meanMs: 900 })),
      stop: vi.fn(),
    };
    const { watchdog, shellCmd, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      eventLoopLagMonitor,
      fetchImpl: async () => {
        const error = new Error("gateway health request timed out");
        error.name = "AbortError";
        throw error;
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
        eventLoopLag: expect.objectContaining({
          overloaded: true,
          p95Ms: 1500,
          maxMs: 4000,
        }),
      }),
    );
    expect(shellCmd).not.toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          selfOverloaded: true,
          failureType: "timeout",
          eventLoopLag: expect.objectContaining({
            overloaded: true,
            p95Ms: 1500,
            maxMs: 4000,
          }),
        }),
      }),
    );
    watchdog.stop();
    expect(eventLoopLagMonitor.stop).toHaveBeenCalled();
  });

  it("does not suppress connection failures when event-loop lag is high", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      eventLoopLagMonitor: {
        sample: vi.fn(() => ({ p95Ms: 1500, maxMs: 4000, meanMs: 900 })),
        stop: vi.fn(),
      },
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "degraded",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "failed",
        details: expect.objectContaining({
          reason: "connect ECONNREFUSED 127.0.0.1:18789",
        }),
      }),
    );
    expect(
      insertWatchdogEvent.mock.calls.some((call) => call?.[0]?.details?.selfOverloaded),
    ).toBe(false);
    watchdog.stop();
  });

  it("does not suppress explicit gateway unhealthy responses when event-loop lag is high", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      eventLoopLagMonitor: {
        sample: vi.fn(() => ({ p95Ms: 1500, maxMs: 4000, meanMs: 900 })),
        stop: vi.fn(),
      },
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: "gateway explicitly unhealthy" }),
      }),
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "degraded",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "failed",
        details: expect.objectContaining({
          reason: "gateway explicitly unhealthy",
        }),
      }),
    );
    expect(
      insertWatchdogEvent.mock.calls.some((call) => call?.[0]?.details?.selfOverloaded),
    ).toBe(false);
    watchdog.stop();
  });

  it("triggers auto-repair in crash-loop mode when enabled", async () => {
    const { watchdog, shellCmd } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(shellCmd).toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
  });

  it("runs pinned plugin reconciliation after doctor repair", async () => {
    const calls = [];
    const reconcileOpenclawPlugins = vi.fn(async () => {
      calls.push("reconcile");
      return {
        currentOpenclawVersion: "2026.5.20",
        targetOpenclawVersion: "2026.5.20",
        plugins: [
          {
            id: "discord",
            package: "@openclaw/discord",
            version: "2026.5.20",
            action: "skipped",
          },
        ],
      };
    });
    const { watchdog, shellCmd, launchGatewayProcess, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      reconcileOpenclawPlugins,
      shellCmdImpl: async (command) => {
        calls.push(command);
        return "fixed";
      },
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    launchGatewayProcess.mockClear();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls).toEqual([kGuardedDoctorRepairCommand, "reconcile"]);
    expect(reconcileOpenclawPlugins).toHaveBeenCalledWith({
      rootDir: "/tmp/alphaclaw",
      openclawDir: "/tmp/alphaclaw/.openclaw",
      fsModule: expect.any(Object),
      logger: expect.any(Object),
      env: process.env,
    });
    expect(launchGatewayProcess).toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin_reconcile",
        source: "repair",
        status: "ok",
        details: expect.objectContaining({ phase: "after_doctor" }),
      }),
    );
    expect(shellCmd).toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
  });

  it("fails repair when post-doctor pinned plugin reconciliation fails", async () => {
    const reconcileOpenclawPlugins = vi.fn(async () => {
      throw new Error("pin reconcile failed");
    });
    const { watchdog, shellCmd, insertWatchdogEvent, launchGatewayProcess } = createHarness({
      autoRepair: true,
      reconcileOpenclawPlugins,
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    launchGatewayProcess.mockClear();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(reconcileOpenclawPlugins).toHaveBeenCalledTimes(1);
    expect(shellCmd).toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin_reconcile",
        source: "repair",
        status: "failed",
        details: expect.objectContaining({
          phase: "after_doctor",
          error: "pin reconcile failed",
        }),
      }),
    );
  });

  it("does not run plugin reconciliation when doctor leaves config unsafe", async () => {
    const reconcileOpenclawPlugins = vi.fn(async () => ({ plugins: [] }));
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
      autoRepair: true,
      reconcileOpenclawPlugins,
      openclawConfig: { gateway: {} },
      clawCmdImpl: async () => ({ ok: true, stdout: "" }),
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    launchGatewayProcess.mockClear();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(reconcileOpenclawPlugins).not.toHaveBeenCalled();
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin_reconcile",
        source: "repair",
        status: "failed",
        details: expect.objectContaining({
          phase: "after_doctor",
          code: "OPENCLAW_CONFIG_UNSAFE_FOR_MUTATION",
        }),
      }),
    );
  });

  it("clears crash-loop lifecycle after a healthy check recovery", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("gateway unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crash_loop",
        health: "unhealthy",
      }),
    );

    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "recovery",
        source: "health_timer",
        status: "ok",
        details: expect.objectContaining({
          previousLifecycle: "crash_loop",
          health: "healthy",
        }),
      }),
    );
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("🟢 Gateway healthy again"),
      ),
    ).toBe(true);
    watchdog.stop();
  });

  it("suppresses notifier sends when notifications are disabled", async () => {
    const { watchdog, notifier } = createHarness({
      notificationsDisabled: true,
      autoRepair: false,
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("suppresses failed health checks during expected restart window", async () => {
    const { watchdog, shellCmd, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onExpectedRestart();
    await flushMicrotasks();

    expect(shellCmd).not.toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          expectedRestartActive: true,
        }),
      }),
    );
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "restarting",
        health: "unknown",
      }),
    );
  });

  it("treats non-zero expected exits as crashes", () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });

    watchdog.onGatewayExit({
      code: 1,
      signal: null,
      expectedExit: true,
      stderrTail: ["gateway failed"],
    });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crashed",
        health: "unhealthy",
        crashCountInWindow: 1,
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "crash",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({
          code: 1,
          signal: null,
          stderrTail: ["gateway failed"],
        }),
      }),
    );
  });

  it("ignores duplicate-launch port-in-use exits", () => {
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
      autoRepair: true,
    });

    watchdog.onGatewayExit({
      code: 1,
      signal: null,
      expectedExit: false,
      stderrTail: [
        "Gateway failed to start: another gateway instance is already listening on ws://127.0.0.1:18789",
        "Port 18789 is already in use.",
      ],
    });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
        crashCountInWindow: 0,
      }),
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "ok",
        details: expect.objectContaining({
          duplicateLaunch: true,
          code: 1,
        }),
      }),
    );
  });

  it("ignores OpenClaw systemd duplicate-launch exits", () => {
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
      autoRepair: true,
    });

    watchdog.onGatewayExit({
      code: 78,
      signal: null,
      expectedExit: false,
      stderrTail: [
        "Gateway failed to start: gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop | gateway already running (pid 35163); lock timeout after 5000ms",
        "Port 18789 is already in use.",
      ],
    });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
        crashCountInWindow: 0,
      }),
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "ok",
        details: expect.objectContaining({
          duplicateLaunch: true,
          code: 78,
        }),
      }),
    );
  });

  it("stops suppressing failures after the expected restart timeout", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      clawCmdImpl: async () => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onExpectedRestart();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "degraded",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "failed",
        details: expect.objectContaining({
          reason: "gateway restarting",
        }),
      }),
    );
  });

  it("sends gateway healthy again after deferred auto-repair recovery", async () => {
    let healthChecks = 0;
    const { watchdog, notifier } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("not healthy yet");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("🟢 Gateway healthy again"),
      ),
    ).toBe(true);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
  });

  it("does not repeat auto-repair or notifications while recovery is still pending", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, shellCmd, notifier } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        healthChecks += 1;
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(shellCmd).toHaveBeenCalledTimes(1);
    expect(shellCmd).toHaveBeenCalledWith(
      kGuardedDoctorRepairCommand,
      kExpectedRepairCommandArgs,
    );
    expect(
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("awaiting health check"),
      ),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(healthChecks).toBeGreaterThan(3);
    expect(shellCmd).toHaveBeenCalledTimes(1);
    expect(
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("awaiting health check"),
      ),
    ).toHaveLength(1);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "degraded",
      }),
    );
  });

  it("does not set uptimeStartedAt on start — waits for onGatewayLaunch", () => {
    const { watchdog } = createHarness();

    watchdog.start();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
    watchdog.stop();
  });

  it("sets uptimeStartedAt when onGatewayLaunch fires", () => {
    const { watchdog } = createHarness();

    watchdog.start();
    const before = Date.now();
    watchdog.onGatewayLaunch({ startedAt: before, pid: 1234 });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThanOrEqual(0);
    watchdog.stop();
  });

  it("clears uptimeStartedAt on gateway crash", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onGatewayExit({ code: 1, expectedExit: false });

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("clears uptimeStartedAt on expected restart", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onExpectedRestart();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("clears uptimeStartedAt on expected exit", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onGatewayExit({ code: 0, expectedExit: true });

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("preserves uptimeStartedAt on duplicate-launch exit", () => {
    const { watchdog } = createHarness();

    const startedAt = Date.now() - 5000;
    watchdog.onGatewayLaunch({ startedAt, pid: 1234 });

    watchdog.onGatewayExit({
      code: 78,
      signal: null,
      expectedExit: false,
      stderrTail: ["gateway already running under systemd"],
    });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThan(0);
  });

  it("clears uptimeStartedAt on stop", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.stop();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("restores uptimeStartedAt after crash recovery via onGatewayLaunch", async () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 10_000, pid: 1234 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();

    const newStart = Date.now();
    watchdog.onGatewayLaunch({ startedAt: newStart, pid: 5678 });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThanOrEqual(0);
    watchdog.stop();
  });

  it("writes settings changes to env and updates in-memory status", () => {
    const { watchdog, readEnvFile, writeEnvFile, reloadEnv } = createHarness({
      autoRepair: false,
      notificationsDisabled: false,
    });
    readEnvFile.mockReturnValue([{ key: "OPENAI_API_KEY", value: "x" }]);
    reloadEnv.mockImplementation(() => {
      process.env.WATCHDOG_AUTO_REPAIR = "true";
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
    });

    const settings = watchdog.updateSettings({
      autoRepair: true,
      notificationsEnabled: false,
    });

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: "WATCHDOG_AUTO_REPAIR", value: "true" }),
        expect.objectContaining({
          key: "WATCHDOG_NOTIFICATIONS_DISABLED",
          value: "true",
        }),
      ]),
    );
    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(settings).toEqual({
      autoRepair: true,
      notificationsEnabled: false,
    });
  });
});
