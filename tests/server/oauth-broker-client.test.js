const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OAuthBrokerError,
  buildSshArgs,
  createOAuthBrokerClient,
  runSshJsonRequest,
} = require("../../lib/server/oauth-broker-client");

describe("server/oauth-broker-client", () => {
  it("builds a non-interactive, host-pinned, forwarding-disabled SSH command", () => {
    const args = buildSshArgs({
      host: "10.0.0.2",
      identityFile: "/private/id",
      knownHostsFile: "/private/known_hosts",
    });

    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("GlobalKnownHostsFile=/dev/null");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("PermitLocalCommand=no");
    expect(args.at(-1)).toBe("root@10.0.0.2");
  });

  it("emits only the fixed Codex consumer/provider protocol contract", async () => {
    const requests = [];
    const client = createOAuthBrokerClient({
      requestImpl: async (request) => {
        requests.push(request);
        if (request.operation === "deposit") {
          return { schema_version: 1, operation: "deposit", ok: true };
        }
        if (request.operation === "access_token") {
          return {
            schema_version: 1,
            operation: "access_token",
            ok: true,
            access_token: "short-lived",
            expires_at: 1800000000,
            scopes: ["openid"],
            scopes_known: true,
            refreshed: true,
          };
        }
        return {
          schema_version: 1,
          operation: "revoke",
          ok: true,
          revoked: true,
          provider_revocation: "succeeded",
        };
      },
    });

    await client.depositCodexGrant({
      clientId: "client",
      refreshToken: "durable-secret",
      scopes: ["openid"],
    });
    await client.getCodexAccessToken({ scopes: ["openid"] });
    await client.revokeCodexGrant();

    expect(requests).toEqual([
      {
        schema_version: 1,
        operation: "deposit",
        consumer: "openclaw-codex",
        provider: "openai",
        grant: {
          client_id: "client",
          refresh_token: "durable-secret",
          scopes: ["openid"],
        },
      },
      {
        schema_version: 1,
        operation: "access_token",
        consumer: "openclaw-codex",
        provider: "openai",
        scopes: ["openid"],
      },
      {
        schema_version: 1,
        operation: "revoke",
        consumer: "openclaw-codex",
        provider: "openai",
      },
    ]);
  });

  it("invokes SSH by its absolute system path", async () => {
    let invokedCommand;
    const child = new (require("events").EventEmitter)();
    child.stdout = new (require("events").EventEmitter)();
    child.stderr = new (require("events").EventEmitter)();
    child.stdin = {
      on: vi.fn(),
      end: vi.fn(() => {
        child.stdout.emit(
          "data",
          Buffer.from('{"schema_version":1,"operation":"status","ok":true}'),
        );
        child.emit("close", 0);
      }),
    };
    child.kill = vi.fn();

    await runSshJsonRequest({
      spawnImpl: (command) => {
        invokedCommand = command;
        return child;
      },
      args: [],
      payload: { schema_version: 1, operation: "status" },
    });

    expect(invokedCommand).toBe("/usr/bin/ssh");
  });

  it("discovers only a complete staged broker identity", () => {
    const brokerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ac-oauth-broker-"),
    );
    const trustDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-oauth-trust-"));
    const client = createOAuthBrokerClient({
      brokerDir,
      trustDir,
      trustedOwnerUid: process.getuid(),
    });
    expect(client.isConfigured()).toBe(false);

    fs.writeFileSync(
      path.join(trustDir, "config.json"),
      JSON.stringify({ schema_version: 1, gateway_host: "10.0.0.2" }),
    );
    fs.writeFileSync(path.join(brokerDir, "id_ed25519"), "key", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(trustDir, "known_hosts"), "host", {
      mode: 0o644,
    });
    expect(client.isConfigured()).toBe(true);
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(trustDir, { recursive: true, force: true });
  });

  it("rejects workload-writable trust anchors before sending a request", async () => {
    const brokerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ac-oauth-broker-"),
    );
    const trustDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-oauth-trust-"));
    fs.writeFileSync(path.join(brokerDir, "id_ed25519"), "key", {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(trustDir, "config.json"),
      JSON.stringify({ schema_version: 1, gateway_host: "10.0.0.2" }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(trustDir, "known_hosts"), "host", {
      mode: 0o666,
    });
    fs.chmodSync(path.join(trustDir, "known_hosts"), 0o666);
    const spawnImpl = vi.fn();
    const client = createOAuthBrokerClient({
      brokerDir,
      trustDir,
      trustedOwnerUid: process.getuid(),
      spawnImpl,
    });

    await expect(client.status()).rejects.toMatchObject({
      code: "invalid_config",
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    fs.rmSync(brokerDir, { recursive: true, force: true });
    fs.rmSync(trustDir, { recursive: true, force: true });
  });

  it("rejects malformed access-token responses", async () => {
    const client = createOAuthBrokerClient({
      requestImpl: async () => ({
        schema_version: 1,
        operation: "access_token",
        ok: true,
        access_token: "token",
      }),
    });

    await expect(
      client.getCodexAccessToken({ scopes: [] }),
    ).rejects.toMatchObject({
      name: "OAuthBrokerError",
      code: "invalid_response",
    });
    expect(new OAuthBrokerError("broker_denied").message).not.toContain(
      "token",
    );
  });
});
