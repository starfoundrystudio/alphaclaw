const {
  ensureAlphaClawTailscalePolicy,
  getTailscaleApiTokenValidation,
  createTailscaleFinalizer,
} = require("../../lib/server/onboarding/tailscale-finalizer");

describe("server/onboarding/tailscale-finalizer", () => {
  it("validates Tailscale API access token shape", () => {
    expect(getTailscaleApiTokenValidation("").ok).toBe(false);
    expect(getTailscaleApiTokenValidation("tskey-auth-abc").ok).toBe(false);
    expect(getTailscaleApiTokenValidation("tskey-api-abc").ok).toBe(true);
  });

  it("merges AlphaClaw rules into grants policy without replacing custom policy", () => {
    const input = {
      groups: { "group:dev": ["dev@example.com"] },
      tagOwners: { "tag:db": ["autogroup:admin"] },
      grants: [
        {
          src: ["group:dev"],
          dst: ["tag:db"],
          ip: ["tcp:5432"],
        },
      ],
      ssh: [],
    };

    const result = ensureAlphaClawTailscalePolicy(input);

    expect(result.changed).toBe(true);
    expect(result.policy.groups).toEqual(input.groups);
    expect(result.policy.tagOwners["tag:openclaw"]).toContain("autogroup:admin");
    expect(result.policy.nodeAttrs).toEqual([
      { target: ["tag:openclaw"], attr: ["funnel"] },
    ]);
    expect(result.policy.grants).toEqual([
      input.grants[0],
      {
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        ip: ["tcp:443", "tcp:8443", "tcp:22"],
      },
    ]);
    expect(result.policy.ssh).toEqual([
      {
        action: "accept",
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        users: ["root", "alphaclaw"],
      },
    ]);
  });

  it("adds a distinct cloud-ops SSH rule without editing existing SSH rules", () => {
    const defaultSshRule = {
      src: ["autogroup:member"],
      dst: ["autogroup:self"],
      users: ["autogroup:nonroot", "root"],
      action: "check",
    };
    const partialCloudOpsRule = {
      src: ["cloud-ops@teamyou.ai"],
      dst: ["tag:openclaw"],
      users: ["root"],
      action: "accept",
    };

    const result = ensureAlphaClawTailscalePolicy({
      acls: [],
      ssh: [defaultSshRule, partialCloudOpsRule],
    });

    expect(result.policy.ssh).toEqual([
      defaultSshRule,
      partialCloudOpsRule,
      {
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        users: ["root", "alphaclaw"],
        action: "accept",
      },
    ]);
  });

  it("upgrades existing cloud-ops SSH rule to include tailnet admins", () => {
    const existingCloudOpsRule = {
      src: ["cloud-ops@teamyou.ai"],
      dst: ["tag:openclaw"],
      users: ["root", "alphaclaw"],
      action: "accept",
    };

    const result = ensureAlphaClawTailscalePolicy({
      acls: [],
      ssh: [existingCloudOpsRule],
    });

    expect(result.changed).toBe(true);
    expect(result.policy.ssh).toEqual([
      {
        ...existingCloudOpsRule,
        src: ["cloud-ops@teamyou.ai", "autogroup:admin"],
      },
    ]);
  });

  it("uses ACLs when the policy does not use grants", () => {
    const result = ensureAlphaClawTailscalePolicy({ acls: [] });

    expect(result.policy.grants).toBeUndefined();
    expect(result.policy.acls).toEqual([
      {
        action: "accept",
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw:443", "tag:openclaw:8443", "tag:openclaw:22"],
      },
    ]);
  });

  it("grants raw TCP port 22 without adding Tailscale SSH policy in gateway mode", () => {
    const existingSshRule = {
      action: "check",
      src: ["autogroup:member"],
      dst: ["autogroup:self"],
      users: ["autogroup:nonroot"],
    };
    const result = ensureAlphaClawTailscalePolicy(
      {
        grants: [],
        ssh: [existingSshRule],
      },
      { tailscaleSsh: false },
    );

    expect(result.policy.grants).toEqual([
      {
        src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
        dst: ["tag:openclaw"],
        ip: ["tcp:443", "tcp:8443", "tcp:22"],
      },
    ]);
    expect(result.policy.ssh).toEqual([existingSshRule]);
  });

  it("runs policy, CLI, env, share, and TeamYou finalization in order", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      calls.push(["fetch", url, opts.method || "GET"]);
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => '"etag-1"' },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      calls.push(["shell", cmd]);
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const readEnvFile = vi.fn(() => [
      { key: "OPENAI_API_KEY", value: "sk-test" },
      { key: "TAILSCALE_SERVE_PORT", value: "ignored-in-local-mode" },
    ]);
    const writeEnvFile = vi.fn((vars) => calls.push(["writeEnv", vars]));
    const reloadEnv = vi.fn(() => calls.push(["reloadEnv"]));
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile,
      writeEnvFile,
      reloadEnv,
      fetchImpl,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/api/openclaw/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_123",
      },
    });

    const result = await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });
    const expectedTailscaleAuth = `Basic ${Buffer.from("tskey-api-secret:").toString("base64")}`;

    expect(result).toMatchObject({
      setupUrl: "https://alphaclaw.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw.tail123.ts.net:8443",
      deviceId: "device-123",
    });
    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale up --auth-key='tskey-auth-secret' --hostname='alphaclaw' --ssh",
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([
        { key: "ALPHACLAW_SETUP_URL", value: "https://alphaclaw.tail123.ts.net" },
        {
          key: "ALPHACLAW_PUBLIC_BASE_URL",
          value: "https://alphaclaw.tail123.ts.net:8443",
        },
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://teamyou.example/api/openclaw/webhook",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer callback-secret",
        }),
        body: JSON.stringify({
          type: "instance.network_finalized",
          instance_id: "oc_inst_123",
          setup_url: "https://alphaclaw.tail123.ts.net",
          public_base_url: "https://alphaclaw.tail123.ts.net:8443",
          tailscale_dns: "alphaclaw.tail123.ts.net",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tailscale.com/api/v2/tailnet/-/acl",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expectedTailscaleAuth,
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tailscale.com/api/v2/tailnet/-/settings",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          Authorization: expectedTailscaleAuth,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ httpsEnabled: true }),
      }),
    );
    expect(calls.map((entry) => entry[0])).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "fetch",
      "fetch",
      "shell",
      "shell",
      "shell",
      "fetch",
      "writeEnv",
      "reloadEnv",
      "fetch",
    ]);
  });

  it("requires an instance id when the TeamYou webhook is configured", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/api/openclaw/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
      },
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("OPENCLAW_INSTANCE_ID is required");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shellCmd).not.toHaveBeenCalled();
  });

  it("requires a webhook token when the TeamYou webhook is configured", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/api/openclaw/webhook",
        OPENCLAW_INSTANCE_ID: "oc_inst_123",
      },
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("OPENCLAW_WEBHOOK_TOKEN is required");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shellCmd).not.toHaveBeenCalled();
  });

  it("surfaces an actionable error when the host exposure wrapper is missing", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-secret" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      if (cmd === "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all") {
        const error = new Error("Command failed");
        error.stderr = "sudo: /usr/local/sbin/alphaclaw-tailscale-expose: command not found";
        throw error;
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {},
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow(/older clawctl/);
    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale up --auth-key='tskey-auth-secret' --hostname='alphaclaw' --ssh",
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
  });

  it("reuses an already-joined host on retry after local URLs were written", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              tagOwners: { "tag:openclaw": ["autogroup:admin"] },
              nodeAttrs: [{ target: ["tag:openclaw"], attr: ["funnel"] }],
              grants: [
                {
                  src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
                  dst: ["tag:openclaw"],
                  ip: ["tcp:443", "tcp:8443", "tcp:22"],
                },
              ],
              ssh: [
                {
                  action: "accept",
                  src: ["autogroup:admin", "cloud-ops@teamyou.ai"],
                  dst: ["tag:openclaw"],
                  users: ["root", "alphaclaw"],
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const shellCmd = vi.fn(async (cmd) => {
      if (cmd === "tailscale status --json") {
        return JSON.stringify({
          Self: {
            ID: "device-123",
            DNSName: "alphaclaw.tail123.ts.net.",
          },
        });
      }
      return "";
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      constants: { OPENCLAW_DIR: "/tmp/openclaw" },
      readEnvFile: vi.fn(() => [
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      env: {},
    });

    await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(shellCmd.mock.calls.map(([cmd]) => cmd)).toEqual([
      "tailscale status --json",
      "sudo -n /usr/local/sbin/alphaclaw-tailscale-expose configure-all",
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/keys"))).toBe(false);
  });

  it("configures, records, writes back, seals, and cleans up a security gateway", async () => {
    const writes = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => '"etag-gateway"' },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-gateway-secret" }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-gateway-123",
                  nodeId: "node-gateway-123",
                  name: "alphaclaw-gateway.tail123.ts.net",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const gatewayTailscaleClient = {
      status: vi.fn(async () => ({ configured: false, sealed: false })),
      configure: vi.fn(async () => ({
        configured: true,
        sealed: false,
        dnsName: "alphaclaw-gateway.tail123.ts.net",
        deviceId: "node-gateway-123",
      })),
      seal: vi.fn(async () => ({ sealed: true })),
      cleanupIdentity: vi.fn(),
    };
    const shellCmd = vi.fn();
    const readEnvFile = vi.fn(() => [
      { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
      {
        key: "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE",
        value: "/run/alphaclaw/gateway-setup",
      },
    ]);
    const writeEnvFile = vi.fn((vars) => {
      writes.push(vars.map((entry) => ({ ...entry })));
    });
    const finalizer = createTailscaleFinalizer({
      shellCmd,
      readEnvFile,
      writeEnvFile,
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/api/openclaw/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    const result = await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(result).toMatchObject({
      setupUrl: "https://alphaclaw-gateway.tail123.ts.net",
      publicBaseUrl: "https://alphaclaw-gateway.tail123.ts.net:8443",
      dnsName: "alphaclaw-gateway.tail123.ts.net",
      deviceId: "device-gateway-123",
    });
    expect(shellCmd).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.status).toHaveBeenCalledOnce();
    expect(gatewayTailscaleClient.configure).toHaveBeenCalledWith({
      authKey: "tskey-auth-gateway-secret",
      hostname: "alphaclaw",
      servePort: 443,
      funnelPort: 8443,
      enableSshBridge: true,
    });
    expect(gatewayTailscaleClient.seal).toHaveBeenCalledOnce();
    expect(gatewayTailscaleClient.cleanupIdentity).toHaveBeenCalledOnce();
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
          value: "https://alphaclaw-gateway.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
          value: "https://alphaclaw-gateway.tail123.ts.net:8443",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DNS",
          value: "alphaclaw-gateway.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DEVICE_ID",
          value: "device-gateway-123",
        },
        {
          key: "ALPHACLAW_TAILSCALE_HOST_ROLE",
          value: "security_gateway",
        },
        {
          key: "ALPHACLAW_GATEWAY_SETUP_SEALED",
          value: "false",
        },
      ]),
    );
    expect(writes[1]).toEqual(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw-gateway.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_PUBLIC_BASE_URL",
          value: "https://alphaclaw-gateway.tail123.ts.net:8443",
        },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
          value: "",
        },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
          value: "",
        },
        { key: "ALPHACLAW_GATEWAY_SETUP_SEALED", value: "true" },
      ]),
    );
    expect(JSON.stringify(writes)).not.toContain("tskey-api-secret");
    expect(JSON.stringify(writes)).not.toContain(
      "tskey-auth-gateway-secret",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://teamyou.example/api/openclaw/webhook",
      expect.objectContaining({
        body: JSON.stringify({
          type: "instance.network_finalized",
          instance_id: "oc_inst_gateway",
          setup_url: "https://alphaclaw-gateway.tail123.ts.net",
          public_base_url: "https://alphaclaw-gateway.tail123.ts.net:8443",
          tailscale_dns: "alphaclaw-gateway.tail123.ts.net",
          tailscale_device_id: "device-gateway-123",
          tailscale_host_role: "security_gateway",
        }),
      }),
    );

    const policyWrite = fetchImpl.mock.calls.find(
      ([url, opts]) =>
        String(url).endsWith("/acl") && opts?.method === "POST",
    );
    expect(JSON.parse(policyWrite[1].body).ssh).toBeUndefined();
  });

  it("keeps the gateway setup channel open when TeamYou writeback fails", async () => {
    const writes = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/keys")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ key: "tskey-auth-gateway-secret" }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-gateway-123",
                  name: "alphaclaw.tail123.ts.net",
                },
              ],
            }),
        };
      }
      if (String(url).includes("teamyou.example")) {
        return {
          ok: false,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ error: "failed" }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const gatewayTailscaleClient = {
      status: vi.fn(async () => ({ configured: false })),
      configure: vi.fn(async () => ({
        configured: true,
        dnsName: "alphaclaw.tail123.ts.net",
        deviceId: "device-gateway-123",
      })),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
      ]),
      writeEnvFile: vi.fn((vars) =>
        writes.push(vars.map((entry) => ({ ...entry }))),
      ),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("TeamYou writeback failed");
    expect(gatewayTailscaleClient.seal).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.cleanupIdentity).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
      ]),
    );
    expect(writes[0]).not.toEqual(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
      ]),
    );
  });

  it("reuses sealed gateway identity metadata without reopening the setup channel", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-gateway-123",
                  name: "alphaclaw.tail123.ts.net",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const gatewayTailscaleClient = {
      status: vi.fn(),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_PUBLIC_BASE_URL",
          value: "https://alphaclaw.tail123.ts.net:8443",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DNS",
          value: "alphaclaw.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DEVICE_ID",
          value: "device-gateway-123",
        },
        { key: "ALPHACLAW_GATEWAY_SETUP_SEALED", value: "true" },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(gatewayTailscaleClient.status).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.configure).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.seal).not.toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/keys")),
    ).toBe(false);
  });

  it("retries from pending gateway metadata without changing active ingress", async () => {
    const writes = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-gateway-123",
                  name: "alphaclaw.tail123.ts.net",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const gatewayTailscaleClient = {
      status: vi.fn(),
      configure: vi.fn(),
      seal: vi.fn(async () => ({ sealed: true })),
      cleanupIdentity: vi.fn(),
    };
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
          value: "https://alphaclaw.tail123.ts.net:8443",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DNS",
          value: "alphaclaw.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_TAILSCALE_DEVICE_ID",
          value: "device-gateway-123",
        },
        {
          key: "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE",
          value: "/run/alphaclaw/gateway-setup",
        },
        { key: "ALPHACLAW_GATEWAY_SETUP_SEALED", value: "false" },
      ]),
      writeEnvFile: vi.fn((vars) =>
        writes.push(vars.map((entry) => ({ ...entry }))),
      ),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(gatewayTailscaleClient.status).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.configure).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.seal).toHaveBeenCalledOnce();
    expect(gatewayTailscaleClient.cleanupIdentity).toHaveBeenCalledOnce();
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/keys")),
    ).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        {
          key: "ALPHACLAW_SETUP_URL",
          value: "https://alphaclaw.tail123.ts.net",
        },
        {
          key: "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
          value: "",
        },
        { key: "ALPHACLAW_GATEWAY_SETUP_SEALED", value: "true" },
      ]),
    );
  });

  it("durably records a gateway that reports itself already sealed", async () => {
    const writes = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-gateway-123",
                  name: "alphaclaw.tail123.ts.net",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const gatewayTailscaleClient = {
      status: vi.fn(async () => ({
        configured: true,
        sealed: true,
        dnsName: "alphaclaw.tail123.ts.net",
        deviceId: "device-gateway-123",
      })),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
        {
          key: "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE",
          value: "/run/alphaclaw/gateway-setup",
        },
      ]),
      writeEnvFile: vi.fn((vars) =>
        writes.push(vars.map((entry) => ({ ...entry }))),
      ),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    await finalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: "tskey-api-secret",
    });

    expect(writes[0]).toEqual(
      expect.arrayContaining([
        { key: "ALPHACLAW_GATEWAY_SETUP_SEALED", value: "true" },
      ]),
    );
    expect(gatewayTailscaleClient.seal).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.cleanupIdentity).toHaveBeenCalledOnce();
  });

  it("does not persist a gateway outside the requested tailnet", async () => {
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      if (String(url).endsWith("/acl") && (!opts.method || opts.method === "GET")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () => JSON.stringify({ grants: [] }),
        };
      }
      if (String(url).endsWith("/devices")) {
        return {
          ok: true,
          headers: { get: () => "" },
          text: async () =>
            JSON.stringify({
              devices: [
                {
                  id: "device-foreign-123",
                  name: "different-device.requested-tailnet.ts.net",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "" },
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    const writeEnvFile = vi.fn();
    const gatewayTailscaleClient = {
      status: vi.fn(async () => ({
        configured: true,
        sealed: false,
        dnsName: "alphaclaw.foreign-tailnet.ts.net",
        deviceId: "device-foreign-123",
      })),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
      ]),
      writeEnvFile,
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {
        OPENCLAW_WEBHOOK_URL: "https://teamyou.example/webhook",
        OPENCLAW_WEBHOOK_TOKEN: "callback-secret",
        OPENCLAW_INSTANCE_ID: "oc_inst_gateway",
      },
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("does not belong to the requested Tailscale tailnet");

    expect(writeEnvFile).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.seal).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.cleanupIdentity).not.toHaveBeenCalled();
  });

  it("requires TeamYou writeback before mutating a security gateway", async () => {
    const gatewayTailscaleClient = {
      status: vi.fn(),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {},
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow(
      "TeamYou writeback is required for security gateway onboarding",
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.status).not.toHaveBeenCalled();
  });

  it("rejects a nonstandard security gateway Serve port before configuration", async () => {
    const gatewayTailscaleClient = {
      status: vi.fn(),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
        { key: "TAILSCALE_SERVE_PORT", value: "9443" },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {},
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("Tailscale Serve port must be 443");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.status).not.toHaveBeenCalled();
  });

  it("rejects a nonstandard security gateway Funnel port before configuration", async () => {
    const gatewayTailscaleClient = {
      status: vi.fn(),
      configure: vi.fn(),
      seal: vi.fn(),
      cleanupIdentity: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const finalizer = createTailscaleFinalizer({
      shellCmd: vi.fn(),
      readEnvFile: vi.fn(() => [
        { key: "ALPHACLAW_CONNECTIVITY_MODE", value: "security_gateway" },
        { key: "TAILSCALE_FUNNEL_PORT", value: "9443" },
      ]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      fetchImpl,
      gatewayTailscaleClient,
      env: {},
    });

    await expect(
      finalizer.finalizeTailscaleOnboarding({
        tailscaleApiToken: "tskey-api-secret",
      }),
    ).rejects.toThrow("Tailscale Funnel port must be 8443");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gatewayTailscaleClient.status).not.toHaveBeenCalled();
  });
});
