const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  kManagedCpxAgentMaxConcurrent,
  capManagedCpxAgentConcurrency,
  ensureManagedOpenclawDefaults,
} = require("../../lib/server/managed-defaults-config");

describe("server/managed-defaults-config", () => {
  it("strips config keys retired by OpenClaw 2026.9 on every reconcile", () => {
    // G2 finding #1: Doctor migrates these keys away, but a stale writer put
    // them back and every later OpenClaw CLI call refused the config.
    const config = {
      agents: {
        defaults: {
          memorySearch: { provider: "local", local: { contextSize: 2048 } },
          model: { primary: "openai/gpt-5.6-sol" },
        },
      },
      plugins: { bundledDiscovery: "compat", allow: ["memory-core"] },
    };

    const result = ensureManagedOpenclawDefaults(config);

    expect(result.changed).toBe(true);
    expect(result.config.agents.defaults.memorySearch).toBeUndefined();
    expect(result.config.agents.defaults.model).toEqual({
      primary: "openai/gpt-5.6-sol",
    });
    expect(result.config.plugins.bundledDiscovery).toBeUndefined();
    expect(result.config.plugins.allow).toEqual(["memory-core"]);
  });

  it("applies every managed default while preserving adjacent settings", () => {
    const config = {
      agents: {
        defaults: {
          maxConcurrent: 12,
          model: { primary: "openai/gpt-5.6-sol" },
          subagents: { maxConcurrent: 6, maxSpawnDepth: 2 },
        },
      },
      plugins: {
        allow: ["memory-core", "usage-tracker"],
        entries: {
          "memory-core": {
            enabled: true,
            config: { dreaming: { enabled: true, frequency: "weekly" } },
          },
          "usage-tracker": { enabled: true },
        },
      },
      skills: {
        load: { extraDirs: ["/srv/skills"] },
        workshop: {
          approvalPolicy: "auto",
          autonomous: { mode: "auto" },
        },
      },
      tools: {
        profile: "full",
        deny: ["browser"],
        swarm: { enabled: true, maxConcurrent: 5 },
      },
      gateway: {
        mode: "local",
        cliAgents: { enabled: true },
        terminal: { enabled: true, shell: "/bin/zsh" },
      },
      telemetry: {
        enabled: true,
        consentedAt: "2026-09-01T00:00:00.000Z",
      },
      secrets: {
        providers: { default: { source: "env" } },
        egressProxy: { enabled: true, allowedHosts: ["api.openai.com"] },
      },
      channels: { telegram: { enabled: true } },
    };

    const result = ensureManagedOpenclawDefaults(config);

    expect(result.changed).toBe(true);
    expect(result.config.agents.defaults.maxConcurrent).toBe(3);
    expect(result.config.agents.defaults.model).toEqual({
      primary: "openai/gpt-5.6-sol",
    });
    expect(result.config.agents.defaults.subagents).toEqual({
      maxConcurrent: 6,
      maxSpawnDepth: 2,
    });
    expect(
      result.config.plugins.entries["memory-core"].config.dreaming,
    ).toEqual({ enabled: false, frequency: "weekly" });
    expect(result.config.plugins.entries["usage-tracker"]).toEqual({
      enabled: true,
    });
    expect(result.config.skills).toEqual({
      load: { extraDirs: ["/srv/skills"] },
      workshop: {
        approvalPolicy: "auto",
        autonomous: { mode: "propose" },
      },
    });
    expect(result.config.tools).toEqual({
      profile: "full",
      deny: ["browser", "secrets"],
      swarm: { enabled: false, maxConcurrent: 5 },
    });
    expect(result.config.gateway).toEqual({
      mode: "local",
      cliAgents: { enabled: false },
      terminal: { enabled: false, shell: "/bin/zsh" },
    });
    expect(result.config.telemetry).toEqual({
      enabled: false,
      consentedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(result.config.secrets).toEqual({
      providers: { default: { source: "env" } },
      egressProxy: { enabled: false, allowedHosts: ["api.openai.com"] },
    });
    expect(result.config.channels).toEqual({ telegram: { enabled: true } });

    expect(ensureManagedOpenclawDefaults(result.config).changed).toBe(false);
  });

  it("caps Telegram-managed concurrency without raising a lower explicit value", () => {
    const high = {
      agents: { defaults: { maxConcurrent: 12, subagents: { maxConcurrent: 7 } } },
    };
    const low = { agents: { defaults: { maxConcurrent: 2 } } };
    const missing = {};

    expect(capManagedCpxAgentConcurrency(high)).toBe(kManagedCpxAgentMaxConcurrent);
    expect(high.agents.defaults.subagents.maxConcurrent).toBe(7);
    expect(capManagedCpxAgentConcurrency(low)).toBe(2);
    expect(capManagedCpxAgentConcurrency(missing)).toBe(3);
  });

  it("writes defaults accepted by the pinned OpenClaw config schema", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-defaults-"));
    const configPath = path.join(tempDir, "openclaw.json");
    try {
      const { config } = ensureManagedOpenclawDefaults({
        gateway: { mode: "local" },
      });
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const validation = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, "../../node_modules/openclaw/openclaw.mjs"),
          "config",
          "validate",
          "--json",
        ],
        {
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: tempDir,
          },
          encoding: "utf8",
        },
      );
      expect(validation).toMatchObject({
        status: 0,
        signal: null,
        stderr: "",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
