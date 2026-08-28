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

  it("emits only the fixed Claude consumer/provider protocol contract", async () => {
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
            scopes: ["user:inference"],
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

    await client.depositClaudeGrant({ refreshToken: "durable-secret" });
    await client.getClaudeAccessToken();
    await client.revokeClaudeGrant();

    expect(requests).toEqual([
      {
        schema_version: 1,
        operation: "deposit",
        consumer: "claude-cli",
        provider: "anthropic",
        grant: {
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          refresh_token: "durable-secret",
          scopes: ["user:inference"],
          extra_params: { expires_in: "3600" },
        },
      },
      {
        schema_version: 1,
        operation: "access_token",
        consumer: "claude-cli",
        provider: "anthropic",
      },
      {
        schema_version: 1,
        operation: "revoke",
        consumer: "claude-cli",
        provider: "anthropic",
      },
    ]);
  });

  it("limits gog grants and leases to the five fixed Google account slots", async () => {
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

    await client.depositGogGrant({
      consumer: "gog-2",
      clientId: "owner-client",
      clientSecret: "owner-secret",
      refreshToken: "durable-secret",
      scopes: ["openid"],
    });
    await client.getGogAccessToken({ consumer: "gog-2" });
    await client.revokeGogGrant({ consumer: "gog-2" });
    await expect(
      client.getGogAccessToken({ consumer: "gog-owner-controlled" }),
    ).rejects.toMatchObject({ code: "invalid_consumer" });

    expect(requests).toEqual([
      {
        schema_version: 1,
        operation: "deposit",
        consumer: "gog-2",
        provider: "google",
        grant: {
          client_id: "owner-client",
          client_secret: "owner-secret",
          refresh_token: "durable-secret",
          scopes: ["openid"],
        },
      },
      {
        schema_version: 1,
        operation: "access_token",
        consumer: "gog-2",
        provider: "google",
      },
      {
        schema_version: 1,
        operation: "revoke",
        consumer: "gog-2",
        provider: "google",
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
    const client = createOAuthBrokerClient({ brokerDir });
    expect(client.isConfigured()).toBe(false);

    fs.writeFileSync(
      path.join(brokerDir, "config.json"),
      JSON.stringify({ schema_version: 1, gateway_host: "10.0.0.2" }),
    );
    fs.writeFileSync(path.join(brokerDir, "id_ed25519"), "key", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(brokerDir, "known_hosts"), "host", {
      mode: 0o644,
    });
    expect(client.isConfigured()).toBe(true);
    fs.rmSync(brokerDir, { recursive: true, force: true });
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
