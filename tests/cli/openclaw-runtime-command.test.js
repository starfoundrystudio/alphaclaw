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

    expect(env).toEqual({
      HOME: "/home/alphaclaw",
      OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
      SSL_CERT_FILE: "/private/agent-vault-ca.pem",
    });
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
        env: {
          HOME: "/home/alphaclaw",
          OPENCLAW_PROXY_URL: "http://vault:token@127.0.0.1:14322/",
        },
        stdio: "inherit",
      },
    );
  });
});
