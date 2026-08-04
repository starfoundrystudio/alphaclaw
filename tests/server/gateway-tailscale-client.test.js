const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const {
  buildSshArgs,
  createGatewayTailscaleClient,
  normalizeGatewayStatus,
} = require("../../lib/server/onboarding/gateway-tailscale-client");

const createTempCredentials = () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "alphaclaw-gateway-client-"),
  );
  const identityFile = path.join(root, "setup-key");
  const knownHostsFile = path.join(root, "known-hosts");
  fs.writeFileSync(identityFile, "private");
  fs.chmodSync(identityFile, 0o600);
  fs.writeFileSync(knownHostsFile, "10.0.0.2 ssh-ed25519 AAAA\n");
  fs.chmodSync(knownHostsFile, 0o644);
  return { root, identityFile, knownHostsFile };
};

const createSpawn = ({ response, exitCode = 0, stderr = "" }) => {
  const calls = [];
  const requests = [];
  const spawnImpl = vi.fn((command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();

    let request = "";
    child.stdin.on("data", (chunk) => {
      request += chunk.toString("utf8");
    });
    child.stdin.on("finish", () => {
      requests.push(JSON.parse(request));
      if (stderr) child.stderr.write(stderr);
      if (response) child.stdout.write(JSON.stringify(response));
      child.stderr.end();
      child.stdout.end();
      queueMicrotask(() => child.emit("close", exitCode));
    });
    return child;
  });
  return { spawnImpl, calls, requests };
};

describe("server/onboarding/gateway-tailscale-client", () => {
  it("uses pinned noninteractive SSH and sends the auth key only over stdin", async () => {
    const credentials = createTempCredentials();
    const spawned = createSpawn({
      response: {
        schema_version: 2,
        operation: "configure",
        ok: true,
        configured: true,
        sealed: false,
        tailscale_dns: "alpha.tail123.ts.net.",
        tailscale_device_id: "device-123",
        agent_vault_operator_url:
          "https://agent-vault-test.tail123.ts.net",
      },
    });
    const client = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: spawned.spawnImpl,
    });

    const result = await client.configure({
      authKey: "tskey-auth-secret",
      hostname: "alphaclaw",
      servePort: 443,
      funnelPort: 8443,
      enableSshBridge: true,
      agentVaultServiceName: "svc:agent-vault-test",
    });

    expect(result).toEqual({
      configured: true,
      sealed: false,
      dnsName: "alpha.tail123.ts.net",
      deviceId: "device-123",
      tailnet: "",
      agentVaultOperatorUrl:
        "https://agent-vault-test.tail123.ts.net",
    });
    expect(spawned.calls[0].command).toBe("ssh");
    expect(spawned.calls[0].args).toEqual(
      buildSshArgs({
        host: "10.0.0.2",
        port: 22,
        user: "root",
        identityFile: credentials.identityFile,
        knownHostsFile: credentials.knownHostsFile,
      }),
    );
    expect(spawned.calls[0].args.join(" ")).not.toContain(
      "tskey-auth-secret",
    );
    expect(spawned.calls[0].options.env).toEqual({
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    });
    expect(spawned.requests).toEqual([
      {
        schema_version: 2,
        operation: "configure",
        auth_key: "tskey-auth-secret",
        hostname: "alphaclaw",
        serve_port: 443,
        funnel_port: 8443,
        enable_ssh_bridge: true,
        agent_vault_service_name: "svc:agent-vault-test",
      },
    ]);

    fs.rmSync(credentials.root, { recursive: true, force: true });
  });

  it("rejects setup identity files readable by group or other users", async () => {
    const credentials = createTempCredentials();
    fs.chmodSync(credentials.identityFile, 0o644);
    const client = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: vi.fn(),
    });

    await expect(client.status()).rejects.toThrow(
      "permissions are too broad",
    );
    fs.rmSync(credentials.root, { recursive: true, force: true });
  });

  it("rejects writable or symlinked known-hosts files", async () => {
    const writableCredentials = createTempCredentials();
    fs.chmodSync(writableCredentials.knownHostsFile, 0o666);
    const writableClient = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: writableCredentials.identityFile,
      knownHostsFile: writableCredentials.knownHostsFile,
      spawnImpl: vi.fn(),
    });

    await expect(writableClient.status()).rejects.toThrow(
      "permissions are too broad",
    );
    fs.rmSync(writableCredentials.root, { recursive: true, force: true });

    const symlinkCredentials = createTempCredentials();
    const realKnownHostsFile = path.join(
      symlinkCredentials.root,
      "known-hosts-real",
    );
    fs.renameSync(symlinkCredentials.knownHostsFile, realKnownHostsFile);
    fs.symlinkSync(realKnownHostsFile, symlinkCredentials.knownHostsFile);
    const symlinkClient = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: symlinkCredentials.identityFile,
      knownHostsFile: symlinkCredentials.knownHostsFile,
      spawnImpl: vi.fn(),
    });

    await expect(symlinkClient.status()).rejects.toThrow(
      "must be a regular file",
    );
    fs.rmSync(symlinkCredentials.root, { recursive: true, force: true });
  });

  it("does not include gateway stderr in command failures", async () => {
    const credentials = createTempCredentials();
    const spawned = createSpawn({
      exitCode: 1,
      stderr: "failed tskey-auth-should-never-escape",
    });
    const client = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: spawned.spawnImpl,
    });

    await expect(client.status()).rejects.toThrow(
      "Gateway setup command failed",
    );
    await expect(client.status()).rejects.not.toThrow(
      /tskey-auth-should-never-escape/,
    );
    fs.rmSync(credentials.root, { recursive: true, force: true });
  });

  it("validates the gateway response schema and identity", () => {
    expect(() =>
      normalizeGatewayStatus(
        {
          schema_version: 3,
          operation: "status",
          ok: true,
        },
        "status",
      ),
    ).toThrow("schema version is incompatible");
    expect(() =>
      normalizeGatewayStatus(
        {
          schema_version: 2,
          operation: "status",
          ok: true,
          configured: true,
          tailscale_dns: "not-tailscale.example.com",
          tailscale_device_id: "device-123",
        },
        "status",
      ),
    ).toThrow("DNS name is invalid");
  });

  it("rejects legacy schema-v1 gateways before Agent Vault onboarding", () => {
    expect(() =>
      normalizeGatewayStatus(
        {
          schema_version: 1,
          operation: "status",
          ok: true,
          configured: true,
          sealed: false,
          tailscale_dns: "alpha.tail123.ts.net.",
          tailscale_device_id: "device-123",
        },
        "status",
      ),
    ).toThrow("schema version is incompatible");
  });

  it("removes the one-time private identity after sealing", () => {
    const credentials = createTempCredentials();
    const client = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: vi.fn(),
    });

    client.cleanupIdentity();

    expect(fs.existsSync(credentials.identityFile)).toBe(false);
    expect(fs.existsSync(credentials.knownHostsFile)).toBe(true);
    fs.rmSync(credentials.root, { recursive: true, force: true });
  });

  it("claims and acknowledges the Agent Vault runtime token over stdin", async () => {
    const credentials = createTempCredentials();
    const claimSpawn = createSpawn({
      response: {
        schema_version: 2,
        operation: "agent_vault_runtime_token",
        ok: true,
        configured: true,
        sealed: true,
        runtime_token_ready: true,
        runtime_token: "av_runtime_token_123456789",
      },
    });
    const claimClient = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: claimSpawn.spawnImpl,
    });

    await expect(claimClient.claimAgentVaultRuntimeToken()).resolves.toEqual({
      ready: true,
      token: "av_runtime_token_123456789",
    });
    expect(claimSpawn.requests[0]).toEqual({
      schema_version: 2,
      operation: "agent_vault_runtime_token",
    });

    const ackSpawn = createSpawn({
      response: {
        schema_version: 2,
        operation: "agent_vault_runtime_token_ack",
        ok: true,
        configured: true,
        sealed: true,
        acknowledged: true,
      },
    });
    const ackClient = createGatewayTailscaleClient({
      host: "10.0.0.2",
      identityFile: credentials.identityFile,
      knownHostsFile: credentials.knownHostsFile,
      spawnImpl: ackSpawn.spawnImpl,
    });
    const tokenSha256 = "a".repeat(64);
    await expect(
      ackClient.acknowledgeAgentVaultRuntimeToken({ tokenSha256 }),
    ).resolves.toEqual({ acknowledged: true });
    expect(ackSpawn.requests[0]).toEqual({
      schema_version: 2,
      operation: "agent_vault_runtime_token_ack",
      token_sha256: tokenSha256,
    });
    fs.rmSync(credentials.root, { recursive: true, force: true });
  });
});
