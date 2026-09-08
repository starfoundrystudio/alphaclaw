const path = require("path");

const {
  createBootstrapKickoffService,
  hasBootstrapKickoffDecision,
  kBootstrapKickoffMessage,
} = require("../../lib/server/bootstrap-kickoff");

const kConstants = {
  kRootDir: "/tmp/alphaclaw",
  OPENCLAW_DIR: "/tmp/openclaw",
  WORKSPACE_DIR: "/tmp/openclaw/workspace",
  kOnboardingMarkerPath: "/tmp/alphaclaw/onboarded.json",
  kBootstrapKickoffMarkerPath: "/tmp/alphaclaw/bootstrap-kickoff.json",
};

const kBootstrapPath = path.join(kConstants.WORKSPACE_DIR, "BOOTSTRAP.md");

const kMarkedAtMs = Date.parse("2026-08-18T12:00:00.000Z");

const createDeps = ({
  onboarded = true,
  kickoffMarker = false,
  bootstrapPending = true,
  workspaceSeeded = true,
  hostFinalizationScheduled = true,
  configuredWorkspace = "",
  defaultWorkspace = "",
  configEnvVars = {},
  skipBootstrap = false,
  // Default: this process was born after onboarding completed (i.e. the
  // post-finalization-restart process), which is allowed to kick off.
  processStartedAtMs = kMarkedAtMs + 30000,
} = {}) => {
  const existingPaths = new Set();
  if (onboarded) existingPaths.add(kConstants.kOnboardingMarkerPath);
  if (kickoffMarker) existingPaths.add(kConstants.kBootstrapKickoffMarkerPath);
  if (workspaceSeeded) {
    const configuredSeededWorkspace = (
      configuredWorkspace ||
      defaultWorkspace ||
      kConstants.WORKSPACE_DIR
    )
      .replaceAll("${OPENCLAW_HOME}", kConstants.kRootDir)
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
        configEnvVars[name] || match,
      );
    const seededWorkspace = configuredSeededWorkspace.startsWith("~/")
      ? path.join(kConstants.kRootDir, configuredSeededWorkspace.slice(2))
      : configuredSeededWorkspace;
    existingPaths.add(seededWorkspace);
    if (bootstrapPending) {
      existingPaths.add(path.join(seededWorkspace, "BOOTSTRAP.md"));
    } else {
      existingPaths.add(path.join(seededWorkspace, "IDENTITY.md"));
    }
  }
  const configPath = path.join(kConstants.OPENCLAW_DIR, "openclaw.json");
  if (
    configuredWorkspace ||
    defaultWorkspace ||
    Object.keys(configEnvVars).length > 0 ||
    skipBootstrap
  ) {
    existingPaths.add(configPath);
  }
  const onboardingMarker = {
    onboarded: true,
    markedAt: new Date(kMarkedAtMs).toISOString(),
    hostFinalizationScheduled,
  };
  return {
    onboardingMarker,
    fs: {
      existsSync: vi.fn((targetPath) => existingPaths.has(targetPath)),
      readFileSync: vi.fn((targetPath) => {
        if (targetPath === kConstants.kOnboardingMarkerPath) {
          return JSON.stringify(onboardingMarker);
        }
        if (
          targetPath === configPath &&
          (configuredWorkspace ||
            defaultWorkspace ||
            Object.keys(configEnvVars).length > 0 ||
            skipBootstrap)
        ) {
          return JSON.stringify({
            ...(Object.keys(configEnvVars).length > 0
              ? { env: { vars: configEnvVars } }
              : {}),
            agents: {
              ...(defaultWorkspace
                ? {
                    defaults: {
                      workspace: defaultWorkspace,
                      ...(skipBootstrap ? { skipBootstrap: true } : {}),
                    },
                  }
                : skipBootstrap
                  ? { defaults: { skipBootstrap: true } }
                : {}),
              ...(configuredWorkspace
                ? {
                    list: [
                      {
                        id: "main",
                        default: true,
                        workspace: configuredWorkspace,
                      },
                    ],
                  }
                : {}),
            },
          });
        }
        if (
          targetPath === kConstants.kBootstrapKickoffMarkerPath &&
          kickoffMarker
        ) {
          return JSON.stringify({ reason: "kickoff_sent" });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    constants: kConstants,
    getProcessStartedAtMs: vi.fn(() => processStartedAtMs),
    isRuntimeReady: vi.fn(async () => true),
    requestGateway: vi.fn(async (method) => {
      if (method === "sessions.list") return { sessions: [] };
      if (method === "chat.send") return { runId: "run-1" };
      throw new Error(`unexpected method: ${method}`);
    }),
    logger: { log: vi.fn(), error: vi.fn() },
    delay: vi.fn(async () => {}),
    env: {
      HOME: "/home/alphaclaw",
      OPENCLAW_HOME: kConstants.kRootDir,
    },
  };
};

const readWrittenMarker = (deps) => {
  const call = deps.fs.writeFileSync.mock.calls.find(
    ([targetPath]) =>
      targetPath.startsWith(`${kConstants.kBootstrapKickoffMarkerPath}.`) &&
      targetPath.endsWith(".tmp"),
  );
  return call ? JSON.parse(call[1]) : null;
};

describe("server/bootstrap-kickoff", () => {
  it.each([
    "kickoff_sent",
    "bootstrap_already_complete",
    "existing_sessions",
    "bootstrap_disabled",
  ])("recognizes a durable handoff decision: %s", (reason) => {
    const fs = {
      readFileSync: vi.fn(() => JSON.stringify({ reason })),
    };

    expect(
      hasBootstrapKickoffDecision({ fs, markerPath: "/marker.json" }),
    ).toBe(true);
  });

  it("rejects missing, malformed, and unfinished kickoff markers", () => {
    const fs = { readFileSync: vi.fn(() => "{partial") };
    expect(
      hasBootstrapKickoffDecision({ fs, markerPath: "/marker.json" }),
    ).toBe(false);
    fs.readFileSync.mockReturnValue(JSON.stringify({ reason: "gave_up" }));
    expect(
      hasBootstrapKickoffDecision({ fs, markerPath: "/marker.json" }),
    ).toBe(false);
    fs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(
      hasBootstrapKickoffDecision({ fs, markerPath: "/marker.json" }),
    ).toBe(false);
  });

  it("skips when not onboarded", async () => {
    const deps = createDeps({ onboarded: false });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "not_onboarded" });
    expect(deps.requestGateway).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("skips when a kickoff decision was already recorded", async () => {
    const deps = createDeps({ kickoffMarker: true });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "already_decided" });
    expect(deps.requestGateway).not.toHaveBeenCalled();
  });

  it("records completion without a kickoff when bootstrap already ran", async () => {
    const deps = createDeps({ bootstrapPending: false });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "bootstrap_already_complete" });
    expect(deps.requestGateway).not.toHaveBeenCalled();
    expect(readWrittenMarker(deps)).toMatchObject({
      kickedOff: false,
      reason: "bootstrap_already_complete",
    });
  });

  it("sends the kickoff message to the default agent main session", async () => {
    const deps = createDeps();
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({
      ok: true,
      reason: "kickoff_sent",
      sessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(deps.requestGateway).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: kBootstrapKickoffMessage,
      idempotencyKey: expect.any(String),
    });
    expect(readWrittenMarker(deps)).toMatchObject({
      kickedOff: true,
      reason: "kickoff_sent",
      sessionKey: "agent:main:main",
      runId: "run-1",
    });
  });

  it("skips the kickoff when agent sessions already exist", async () => {
    const deps = createDeps();
    deps.requestGateway.mockImplementation(async (method) => {
      if (method === "sessions.list") {
        return { sessions: [{ key: "agent:main:telegram:direct:1" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "existing_sessions" });
    expect(deps.requestGateway).not.toHaveBeenCalledWith(
      "chat.send",
      expect.anything(),
    );
    expect(readWrittenMarker(deps)).toMatchObject({
      kickedOff: false,
      reason: "existing_sessions",
    });
  });

  it("retries while the gateway is still coming up", async () => {
    const deps = createDeps();
    let calls = 0;
    deps.requestGateway.mockImplementation(async (method) => {
      if (method === "sessions.list") return { sessions: [] };
      calls += 1;
      if (calls < 3) throw new Error("OpenClaw gateway is not connected");
      return { runId: "run-2" };
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, runId: "run-2" });
    expect(deps.delay).toHaveBeenCalledTimes(2);
  });

  it("keeps the initial handoff recoverable beyond the old retry window", async () => {
    const deps = createDeps();
    let readinessChecks = 0;
    deps.isRuntimeReady.mockImplementation(async () => {
      readinessChecks += 1;
      return readinessChecks > 90;
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.delay).toHaveBeenCalledTimes(90);
  });

  it("uses the configured workspace when deciding an imported handoff", async () => {
    const configuredWorkspace = "/srv/imported-agent-workspace";
    const deps = createDeps({
      configuredWorkspace,
      defaultWorkspace: "/srv/shared-workspace",
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.fs.existsSync).toHaveBeenCalledWith(
      path.join(configuredWorkspace, "BOOTSTRAP.md"),
    );
  });

  it("uses OpenClaw home rather than Unix HOME for a tilde workspace", async () => {
    const configuredWorkspace = "~/.openclaw/imported-workspace";
    const expectedWorkspace = path.join(
      kConstants.kRootDir,
      ".openclaw/imported-workspace",
    );
    const deps = createDeps({ configuredWorkspace });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.fs.existsSync).toHaveBeenCalledWith(
      path.join(expectedWorkspace, "BOOTSTRAP.md"),
    );
  });

  it("expands OpenClaw environment references in an imported workspace", async () => {
    const configuredWorkspace =
      "${OPENCLAW_HOME}/.openclaw/imported-workspace";
    const expectedWorkspace = path.join(
      kConstants.kRootDir,
      ".openclaw/imported-workspace",
    );
    const deps = createDeps({ configuredWorkspace });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.fs.existsSync).toHaveBeenCalledWith(
      path.join(expectedWorkspace, "BOOTSTRAP.md"),
    );
  });

  it("expands workspace references from OpenClaw config environment values", async () => {
    const configuredWorkspace = "${WORKSPACE_ROOT}/agent";
    const workspaceRoot = "/srv/imported-workspaces";
    const deps = createDeps({
      configuredWorkspace,
      configEnvVars: { WORKSPACE_ROOT: workspaceRoot },
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.fs.existsSync).toHaveBeenCalledWith(
      path.join(workspaceRoot, "agent", "BOOTSTRAP.md"),
    );
  });

  it("records a durable decision when bootstrap generation is disabled", async () => {
    const deps = createDeps({ workspaceSeeded: false, skipBootstrap: true });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "bootstrap_disabled" });
    expect(deps.requestGateway).not.toHaveBeenCalled();
    expect(readWrittenMarker(deps)).toMatchObject({
      kickedOff: false,
      reason: "bootstrap_disabled",
    });
  });

  it("retries after a transient config read failure", async () => {
    const configuredWorkspace = "/srv/imported-agent-workspace";
    const deps = createDeps({ configuredWorkspace });
    const originalRead = deps.fs.readFileSync.getMockImplementation();
    const configPath = path.join(kConstants.OPENCLAW_DIR, "openclaw.json");
    let configReads = 0;
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === configPath && configReads++ === 0) {
        throw new SyntaxError("transient partial config");
      }
      return originalRead(targetPath);
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.delay).toHaveBeenCalledTimes(1);
  });

  it("defers in the process that completed onboarding when a finalization restart is scheduled", async () => {
    const deps = createDeps({ processStartedAtMs: kMarkedAtMs - 60000 });
    const service = createBootstrapKickoffService({ ...deps, maxAttempts: 3 });

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "gave_up" });
    expect(deps.requestGateway).not.toHaveBeenCalled();
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    expect(deps.logger.log).toHaveBeenCalledWith(
      expect.stringContaining("host finalization restart pending"),
    );
  });

  it("fires immediately in a process born after onboarding completed", async () => {
    const deps = createDeps({ processStartedAtMs: kMarkedAtMs + 5000 });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.delay).not.toHaveBeenCalled();
  });

  it("fires in the completing process when no finalization restart was scheduled", async () => {
    const deps = createDeps({
      hostFinalizationScheduled: false,
      processStartedAtMs: kMarkedAtMs - 60000,
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.delay).not.toHaveBeenCalled();
  });

  it("fires when an older marker has no hostFinalizationScheduled field", async () => {
    const deps = createDeps({ processStartedAtMs: kMarkedAtMs - 60000 });
    delete deps.onboardingMarker.hostFinalizationScheduled;
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
  });

  it("recovers mid-loop when onboarding clears the scheduled flag after a failed restart", async () => {
    const deps = createDeps({ processStartedAtMs: kMarkedAtMs - 60000 });
    const service = createBootstrapKickoffService({ ...deps, maxAttempts: 5 });
    let reads = 0;
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === kConstants.kOnboardingMarkerPath) {
        reads += 1;
        return JSON.stringify({
          ...deps.onboardingMarker,
          hostFinalizationScheduled: reads < 3,
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.delay).toHaveBeenCalledTimes(2);
  });

  it("waits for runtime and repair readiness before starting the first agent turn", async () => {
    const deps = createDeps();
    deps.isRuntimeReady.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    deps.delay.mockImplementation(async () => {
      expect(deps.requestGateway).not.toHaveBeenCalled();
      expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
    });
    const service = createBootstrapKickoffService(deps);
    expect(await service.maybeRunBootstrapKickoff()).toMatchObject({ reason: "kickoff_sent" });
    expect(deps.delay).toHaveBeenCalledTimes(2);
    expect(deps.requestGateway.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("gives up without a marker so the next boot can retry", async () => {
    const deps = createDeps();
    deps.requestGateway.mockRejectedValue(new Error("gateway down"));
    const service = createBootstrapKickoffService({ ...deps, maxAttempts: 2 });

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toEqual({ ok: false, reason: "gave_up" });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("recovers an incomplete kickoff marker with an atomic replacement", async () => {
    const deps = createDeps({ kickoffMarker: true });
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === kConstants.kOnboardingMarkerPath) {
        return JSON.stringify(deps.onboardingMarker);
      }
      if (targetPath === kConstants.kBootstrapKickoffMarkerPath) return "{partial";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/bootstrap-kickoff\.json\..+\.tmp$/),
      kConstants.kBootstrapKickoffMarkerPath,
    );
  });

  it("starts the first turn so OpenClaw can seed an empty workspace", async () => {
    const deps = createDeps({ workspaceSeeded: false });
    deps.fs.existsSync.mockImplementation((targetPath) =>
      [kConstants.kOnboardingMarkerPath, kConstants.WORKSPACE_DIR].includes(
        targetPath,
      ),
    );
    const service = createBootstrapKickoffService(deps);

    const result = await service.maybeRunBootstrapKickoff();

    expect(result).toMatchObject({ ok: true, reason: "kickoff_sent" });
    expect(deps.requestGateway).toHaveBeenCalledWith(
      "chat.send",
      expect.anything(),
    );
    expect(deps.delay).not.toHaveBeenCalled();
  });

  it("shares a single in-flight run", async () => {
    const deps = createDeps();
    const service = createBootstrapKickoffService(deps);

    const [first, second] = await Promise.all([
      service.maybeRunBootstrapKickoff(),
      service.maybeRunBootstrapKickoff(),
    ]);

    expect(first).toBe(second);
    expect(
      deps.requestGateway.mock.calls.filter(([method]) => method === "chat.send"),
    ).toHaveLength(1);
  });
});
