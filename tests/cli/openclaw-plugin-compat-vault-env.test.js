const fs = require("fs");
const os = require("os");
const path = require("path");

// Regression: once the Agent Vault handoff enables proxy mode in
// openclaw.json, every managed openclaw CLI invocation must carry the vault
// runtime env (OPENCLAW_PROXY_URL and CA trust) or the CLI refuses to start
// and post-onboarding plugin installs fail (observed live 2026-08-24 on a
// vault-enrolled instance switching models to a new provider).
//
// ALPHACLAW_ROOT_DIR must point at the fixture before lib/server/constants is
// first required, so the vault runtime store reads our fixture files.
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "alphaclaw-vault-env-root-"),
);
process.env.ALPHACLAW_ROOT_DIR = fixtureRoot;

const vaultDir = path.join(fixtureRoot, "agent-vault");
fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(vaultDir, "runtime.json"),
  JSON.stringify({
    version: 1,
    token: "av_test_token_1234567890",
    vault: "default",
    mode: "brokered",
    operatorUrl: "https://agent-vault-test.tail0000.ts.net/",
  }),
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(vaultDir, "mitm-ca.pem"),
  "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
  { mode: 0o600 },
);

const { reconcileOpenclawPlugins } = require("../../lib/cli/openclaw-plugin-compat");

describe("managed openclaw CLI env under Agent Vault", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-vault-env-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("spawns openclaw with the vault runtime env merged in", () => {
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({}),
    );
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        openclawVersion: "2026.7.1",
        managedPlugins: {},
      }),
    );
    const seenEnvs = [];
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl: (command, options) => {
        seenEnvs.push(options?.env ?? {});
        if (String(command).includes("'--version'")) return "2026.7.1\n";
        if (String(command).includes("'plugins' 'list' '--json'")) {
          return JSON.stringify({ plugins: [] });
        }
        return "";
      },
      logger: { log: () => {} },
      now: () => "2026-08-24T00:00:00.000Z",
    });

    expect(seenEnvs.length).toBeGreaterThan(0);
    for (const env of seenEnvs) {
      expect(env.OPENCLAW_PROXY_URL).toBe(
        "http://av_test_token_1234567890:default@127.0.0.1:14322/",
      );
      expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(vaultDir, "mitm-ca.pem"));
      // The explicit OpenClaw home overrides must still win over spread envs.
      expect(env.HOME).toBe(rootDir);
      expect(env.OPENCLAW_HOME).toBe(rootDir);
    }
  });
});
