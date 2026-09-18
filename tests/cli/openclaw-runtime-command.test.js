const {
  buildOpenclawRuntimeEnv,
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
      OPENCLAW_CONFIG_READONLY: "1",
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
          OPENCLAW_CONFIG_READONLY: "1",
          OPENCLAW_SUPERVISOR_MODE: "external",
        }),
        stdio: "inherit",
      },
    );
  });

  it("removes only the config write guard for Clawbridge-owned maintenance", () => {
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
});
