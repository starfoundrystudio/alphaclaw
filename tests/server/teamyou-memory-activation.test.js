const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  activateTeamyouMemoryIfBootstrapComplete,
  createTeamyouMemoryActivationService,
  isWorkspaceBootstrapComplete,
} = require("../../lib/server/teamyou-memory-activation");

const createTempRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-teamyou-memory-test-"));

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

describe("server/teamyou-memory-activation", () => {
  it("treats a workspace with BOOTSTRAP.md as pending", () => {
    const root = createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "BOOTSTRAP.md"), "bootstrap", "utf8");

    expect(isWorkspaceBootstrapComplete({ fsModule: fs, workspaceDir })).toEqual({
      complete: false,
      reason: "bootstrap_pending",
      workspaceDir,
    });
  });

  it("treats an existing but unseeded workspace as pending, not complete", () => {
    const root = createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    expect(isWorkspaceBootstrapComplete({ fsModule: fs, workspaceDir })).toEqual({
      complete: false,
      reason: "workspace_not_seeded",
      workspaceDir,
    });
  });

  it("treats a seeded workspace without BOOTSTRAP.md as complete", () => {
    const root = createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "# Identity", "utf8");

    expect(isWorkspaceBootstrapComplete({ fsModule: fs, workspaceDir })).toEqual({
      complete: true,
      reason: "bootstrap_file_absent",
      workspaceDir,
    });
  });

  it("treats a state-tracked seeded workspace without BOOTSTRAP.md as complete", () => {
    const root = createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    writeJson(path.join(workspaceDir, "openclaw-workspace-state.json"), {
      version: 1,
      bootstrapSeededAt: "2026-07-04T00:00:00.000Z",
    });

    expect(isWorkspaceBootstrapComplete({ fsModule: fs, workspaceDir })).toEqual({
      complete: true,
      reason: "bootstrap_file_absent",
      workspaceDir,
    });
  });

  it("leaves memory gated off while OpenClaw bootstrap is pending", async () => {
    const root = createTempRoot();
    const openclawDir = path.join(root, "openclaw");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "BOOTSTRAP.md"), "bootstrap", "utf8");
    writeJson(path.join(openclawDir, "openclaw.json"), {
      plugins: {
        allow: [],
        entries: {
          "active-memory": { enabled: true, config: { enabled: false } },
          "openclaw-teamyou-memory": { enabled: true },
        },
        slots: { memory: "none" },
      },
      skills: {
        entries: {
          teamyou: { enabled: false },
        },
      },
      agents: { defaults: { workspace: workspaceDir } },
      gateway: { mode: "local" },
    });
    const restartGateway = vi.fn();

    const result = await activateTeamyouMemoryIfBootstrapComplete({
      fsModule: fs,
      openclawDir,
      workspaceDir,
      restartGateway,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(result).toMatchObject({
      ok: true,
      activated: false,
      reason: "bootstrap_pending",
      workspaceDir,
    });
    expect(cfg.plugins.slots.memory).toBe("none");
    expect(cfg.skills.entries.teamyou.enabled).toBe(false);
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("repairs leaked managed TeamYou access while bootstrap is pending", async () => {
    const root = createTempRoot();
    const openclawDir = path.join(root, "openclaw");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "BOOTSTRAP.md"), "bootstrap", "utf8");
    writeJson(path.join(openclawDir, "openclaw.json"), {
      plugins: {
        allow: ["openclaw-teamyou-memory", "active-memory"],
        entries: {
          "active-memory": { enabled: true },
          "openclaw-teamyou-memory": { enabled: true },
        },
        slots: { memory: "openclaw-teamyou-memory" },
      },
      skills: {
        entries: {
          teamyou: { enabled: true },
        },
      },
      agents: { defaults: { workspace: workspaceDir } },
      gateway: { mode: "local" },
    });
    const restartGateway = vi.fn(async () => {});

    const result = await activateTeamyouMemoryIfBootstrapComplete({
      fsModule: fs,
      openclawDir,
      workspaceDir,
      restartGateway,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(result).toMatchObject({
      ok: true,
      activated: false,
      repaired: true,
      reason: "bootstrap_pending",
      previousMemorySlot: "openclaw-teamyou-memory",
      previousActiveMemoryEnabled: true,
      previousTeamyouSkillEnabled: true,
      memorySlot: "none",
      activeMemoryEnabled: false,
      teamyouSkillEnabled: false,
      workspaceDir,
    });
    expect(cfg.plugins.slots.memory).toBe("none");
    expect(cfg.plugins.entries["active-memory"].config.enabled).toBe(false);
    expect(cfg.skills.entries.teamyou.enabled).toBe(false);
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("repairs a missing TeamYou skill gate while bootstrap is pending", async () => {
    const root = createTempRoot();
    const openclawDir = path.join(root, "openclaw");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "BOOTSTRAP.md"), "bootstrap", "utf8");
    writeJson(path.join(openclawDir, "openclaw.json"), {
      plugins: {
        allow: ["openclaw-teamyou-memory", "active-memory"],
        entries: {
          "active-memory": { enabled: true, config: { enabled: false } },
          "openclaw-teamyou-memory": { enabled: true },
        },
        slots: { memory: "none" },
      },
      agents: { defaults: { workspace: workspaceDir } },
      gateway: { mode: "local" },
    });
    const restartGateway = vi.fn(async () => {});

    const result = await activateTeamyouMemoryIfBootstrapComplete({
      fsModule: fs,
      openclawDir,
      workspaceDir,
      restartGateway,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(result).toMatchObject({
      ok: true,
      activated: false,
      repaired: true,
      reason: "bootstrap_pending",
      previousTeamyouSkillEnabled: true,
      teamyouSkillEnabled: false,
      workspaceDir,
    });
    expect(cfg.plugins.slots.memory).toBe("none");
    expect(cfg.plugins.entries["active-memory"].config.enabled).toBe(false);
    expect(cfg.skills.entries.teamyou.enabled).toBe(false);
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("enables only the TeamYou skill after bootstrap when memory is not configured", async () => {
    const root = createTempRoot();
    const openclawDir = path.join(root, "openclaw");
    const workspaceDir = path.join(root, "workspace");
    writeJson(path.join(workspaceDir, "openclaw-workspace-state.json"), {
      version: 1,
      setupCompletedAt: "2026-07-04T00:01:00.000Z",
    });
    writeJson(path.join(openclawDir, "openclaw.json"), {
      plugins: {
        allow: [],
        entries: {},
        slots: { memory: "none" },
      },
      skills: {
        entries: {
          teamyou: { enabled: false },
        },
      },
      agents: { defaults: { workspace: workspaceDir } },
      gateway: { mode: "local" },
    });
    const restartGateway = vi.fn(async () => {});

    const result = await activateTeamyouMemoryIfBootstrapComplete({
      fsModule: fs,
      openclawDir,
      workspaceDir,
      restartGateway,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(result).toMatchObject({
      ok: true,
      activated: true,
      reason: "setup_completed_marker",
      memorySlot: "none",
      teamyouSkillEnabled: true,
      workspaceDir,
    });
    expect(cfg.plugins.allow).not.toContain("openclaw-teamyou-memory");
    expect(cfg.plugins.entries["openclaw-teamyou-memory"]).toBeUndefined();
    expect(cfg.plugins.slots.memory).toBe("none");
    expect(cfg.skills.entries.teamyou.enabled).toBe(true);
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("activates the memory slot after workspace setup is complete", async () => {
    const root = createTempRoot();
    const openclawDir = path.join(root, "openclaw");
    const workspaceDir = path.join(root, "workspace");
    writeJson(path.join(workspaceDir, "openclaw-workspace-state.json"), {
      version: 1,
      bootstrapSeededAt: "2026-07-04T00:00:00.000Z",
      setupCompletedAt: "2026-07-04T00:01:00.000Z",
    });
    writeJson(path.join(openclawDir, "openclaw.json"), {
      plugins: {
        allow: [],
        entries: {
          "active-memory": { enabled: true, config: { queryMode: "recent" } },
          "openclaw-teamyou-memory": {
            enabled: true,
            config: { apiKey: "${TEAMYOU_API_KEY}" },
          },
        },
        slots: { memory: "none" },
      },
      skills: {
        entries: {
          teamyou: { enabled: false },
        },
      },
      agents: { defaults: { workspace: workspaceDir } },
      gateway: { mode: "local" },
    });
    const restartGateway = vi.fn(async () => {});

    const result = await activateTeamyouMemoryIfBootstrapComplete({
      fsModule: fs,
      openclawDir,
      workspaceDir,
      restartGateway,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const cfg = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(result).toMatchObject({
      ok: true,
      activated: true,
      reason: "setup_completed_marker",
      memorySlot: "openclaw-teamyou-memory",
      teamyouSkillEnabled: true,
      workspaceDir,
    });
    expect(cfg.plugins.allow).toContain("openclaw-teamyou-memory");
    expect(cfg.plugins.entries["active-memory"]).toEqual({
      enabled: true,
      config: { queryMode: "recent", enabled: true },
    });
    expect(cfg.plugins.entries["openclaw-teamyou-memory"]).toEqual({
      enabled: true,
      config: { apiKey: "${TEAMYOU_API_KEY}" },
    });
    expect(cfg.plugins.slots.memory).toBe("openclaw-teamyou-memory");
    expect(cfg.skills.entries.teamyou.enabled).toBe(true);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(path.join(openclawDir, ".alphaclaw", "teamyou-memory-activated.json")),
    ).toBe(true);
  });

  it("keeps polling when TeamYou is installed after the watcher starts", async () => {
    vi.useFakeTimers();
    try {
      const root = createTempRoot();
      const openclawDir = path.join(root, "openclaw");
      const workspaceDir = path.join(root, "workspace");
      // Boot state: onboarded config, no TeamYou anywhere, workspace not seeded.
      fs.mkdirSync(workspaceDir, { recursive: true });
      writeJson(path.join(openclawDir, "openclaw.json"), {
        plugins: { allow: [], entries: {}, slots: { memory: "none" } },
        agents: { defaults: { workspace: workspaceDir } },
        gateway: { mode: "local" },
      });
      const restartGateway = vi.fn(async () => {});
      const service = createTeamyouMemoryActivationService({
        fsModule: fs,
        openclawDir,
        workspaceDir,
        restartGateway,
        logger: { log: vi.fn(), warn: vi.fn() },
        intervalMs: 1000,
      });

      service.start();
      await vi.runOnlyPendingTimersAsync();

      // clawctl's post-onboard reconcile lands TeamYou (gated) later on.
      writeJson(path.join(openclawDir, "openclaw.json"), {
        plugins: {
          allow: ["openclaw-teamyou-memory", "active-memory"],
          entries: {
            "active-memory": { enabled: true, config: { enabled: false } },
            "openclaw-teamyou-memory": {
              enabled: false,
              config: { apiKey: "${TEAMYOU_API_KEY}" },
            },
          },
          slots: { memory: "none" },
        },
        skills: { entries: { teamyou: { enabled: false } } },
        agents: { defaults: { workspace: workspaceDir } },
        gateway: { mode: "local" },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(restartGateway).not.toHaveBeenCalled();

      // The user completes the OpenClaw bootstrap ritual.
      fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "# Identity", "utf8");
      writeJson(path.join(workspaceDir, "openclaw-workspace-state.json"), {
        version: 1,
        bootstrapSeededAt: "2026-07-05T00:00:00.000Z",
        setupCompletedAt: "2026-07-05T00:10:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(1000);

      const cfg = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.plugins.slots.memory).toBe("openclaw-teamyou-memory");
      expect(cfg.plugins.entries["openclaw-teamyou-memory"].enabled).toBe(true);
      expect(cfg.plugins.entries["active-memory"].config.enabled).toBe(true);
      expect(cfg.skills.entries.teamyou.enabled).toBe(true);
      expect(restartGateway).toHaveBeenCalledTimes(1);
      expect(
        fs.existsSync(
          path.join(openclawDir, ".alphaclaw", "teamyou-memory-activated.json"),
        ),
      ).toBe(true);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
