const {
  buildOpenclawRuntimeEnv,
  isConfigMutatingOpenclawCommand,
  runOpenclawRuntimeCommand,
} = require("../../lib/cli/openclaw-runtime-command");

describe("cli/openclaw-runtime-command", () => {
  it("adds the private Agent Vault runtime environment without dropping caller state", () => {
    const env = buildOpenclawRuntimeEnv({
      env: {
        HOME: "/home/alphaclaw",
        OPENCLAW_PROXY_URL: "http://stale.invalid",
      },
      buildAgentVaultRuntimeEnvImpl: () => ({
        OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
        SSL_CERT_FILE: "/private/agent-vault-ca.pem",
      }),
    });

    expect(env).toEqual(expect.objectContaining({
      HOME: "/home/alphaclaw",
      OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
      SSL_CERT_FILE: "/private/agent-vault-ca.pem",
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_DISABLE_UPDATE_CHECK: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
    }));
  });

  it("passes through command arguments such as plugin help probes", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));

    const status = runOpenclawRuntimeCommand({
      commandArgs: ["openclaw", "plugins", "install", "--help"],
      env: { HOME: "/home/alphaclaw" },
      cwd: "/home/alphaclaw/app",
      spawnSyncImpl,
      buildAgentVaultRuntimeEnvImpl: () => ({
        OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
      }),
    });

    expect(status).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "openclaw",
      ["plugins", "install", "--help"],
      {
        cwd: "/home/alphaclaw/app",
        env: expect.objectContaining({
          HOME: "/home/alphaclaw",
          OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
          OPENCLAW_SUPERVISOR_MODE: "external",
        }),
        stdio: "inherit",
      },
    );
  });

  it("keeps lifecycle controls for Clawbridge-owned maintenance and never sets the config write guard", () => {
    const env = buildOpenclawRuntimeEnv({
      env: { OPENCLAW_CONFIG_READONLY: "1" },
      allowConfigMutation: true,
      buildAgentVaultRuntimeEnvImpl: () => ({}),
    });

    expect(env.OPENCLAW_CONFIG_READONLY).toBeUndefined();
    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
    expect(env.OPENCLAW_NO_AUTO_UPDATE).toBe("1");
  });

  it("recognises OpenClaw subcommands that must write openclaw.json", () => {
    expect(isConfigMutatingOpenclawCommand(["openclaw", "plugins", "install", "/tmp/plugin.tgz", "--pin", "--force"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "plugins", "uninstall", "searxng"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "plugins", "enable", "llama-cpp"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "config", "set", "memory.search.provider", "local"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["/home/alphaclaw/app/node_modules/.bin/openclaw", "plugins", "install", "x"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "plugins", "install", "--help"])).toBe(true);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "plugins", "list"])).toBe(false);
    expect(isConfigMutatingOpenclawCommand(["openclaw", "memory", "status"])).toBe(false);
    expect(isConfigMutatingOpenclawCommand(["bash", "/opt/teamyou.sh", "ty", "agent", "register"])).toBe(false);
    expect(isConfigMutatingOpenclawCommand([])).toBe(false);
  });

  it("runs config-mutating commands without the write guard when asked", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }));

    runOpenclawRuntimeCommand({
      commandArgs: ["openclaw", "plugins", "install", "/tmp/plugin.tgz"],
      env: { HOME: "/home/alphaclaw" },
      cwd: "/home/alphaclaw/app",
      spawnSyncImpl,
      allowConfigMutation: true,
      buildAgentVaultRuntimeEnvImpl: () => ({}),
    });

    const [, , options] = spawnSyncImpl.mock.calls[0];
    expect(options.env.OPENCLAW_CONFIG_READONLY).toBeUndefined();
    expect(options.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(options.env.OPENCLAW_NO_AUTO_UPDATE).toBe("1");
  });
});
