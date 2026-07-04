const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  activateTeamyouMemoryIfBootstrapComplete,
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
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("repairs a leaked managed TeamYou memory slot while bootstrap is pending", async () => {
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
      memorySlot: "none",
      activeMemoryEnabled: false,
      workspaceDir,
    });
    expect(cfg.plugins.slots.memory).toBe("none");
    expect(cfg.plugins.entries["active-memory"].config.enabled).toBe(false);
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
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(path.join(openclawDir, ".alphaclaw", "teamyou-memory-activated.json")),
    ).toBe(true);
  });
});
