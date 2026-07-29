const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("bin/alphaclaw openclaw-runtime", () => {
  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
  const parseCapturedRuntime = (output) => {
    const payload = String(output)
      .split("\n")
      .find((line) => line.startsWith('{"args"'));
    expect(payload).toBeTruthy();
    return JSON.parse(payload);
  };
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-runtime-bin-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("passes Agent Vault proxy state and nested --help arguments through runtime wrappers", () => {
    const vaultDir = path.join(rootDir, "agent-vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    const runtimePath = path.join(vaultDir, "runtime.json");
    const caPath = path.join(vaultDir, "mitm-ca.pem");
    fs.writeFileSync(
      runtimePath,
      `${JSON.stringify({
        version: 1,
        token: "av_abcdefghijklmnop",
        vault: "default",
        mode: "enforced",
        operatorUrl: "https://agent-vault-test.tail1234.ts.net",
        createdAt: "2026-07-29T20:00:00.000Z",
        tokenAcknowledged: true,
        handoffComplete: true,
      })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      caPath,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      { mode: 0o600 },
    );
    const capturePath = path.join(rootDir, "capture-runtime.js");
    fs.writeFileSync(
      capturePath,
      `process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  proxy: process.env.OPENCLAW_PROXY_URL,
  ca: process.env.SSL_CERT_FILE,
  teamyouApiKey: process.env.TEAMYOU_API_KEY,
}) + "\\n");\n`,
    );

    const output = execFileSync(
      process.execPath,
      [
        binPath,
        "--root-dir",
        rootDir,
        "openclaw-runtime",
        "--",
        process.execPath,
        capturePath,
        "--help",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir },
      },
    );

    expect(parseCapturedRuntime(output)).toEqual({
      args: ["--help"],
      proxy: "http://av_abcdefghijklmnop:default@127.0.0.1:14322/",
      ca: caPath,
      teamyouApiKey: "__agent_vault_teamyou_api_key__",
    });

    const guardedOutput = execFileSync(
      process.execPath,
      [
        binPath,
        "--root-dir",
        rootDir,
        "openclaw-doctor-guard",
        "--",
        process.execPath,
        capturePath,
        "--help",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir },
      },
    );
    expect(parseCapturedRuntime(guardedOutput)).toEqual({
      args: ["--help"],
      proxy: "http://av_abcdefghijklmnop:default@127.0.0.1:14322/",
      ca: caPath,
      teamyouApiKey: "__agent_vault_teamyou_api_key__",
    });
  });
});
