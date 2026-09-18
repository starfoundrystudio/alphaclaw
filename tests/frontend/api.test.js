const loadApiModule = async () => import("../../lib/public/js/lib/api.js");

const mockJsonResponse = (status, payload) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

describe("frontend/api", () => {
  const expectLastFetchHeaders = (expectedContentType = "") => {
    const callArgs = global.fetch.mock.calls[global.fetch.mock.calls.length - 1] || [];
    const options = callArgs[1] || {};
    const headers = options.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (expectedContentType) {
      expect(headers.get("Content-Type")).toBe(expectedContentType);
    }
    return { callArgs, options, headers };
  };

  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
  });

  it("fetchStatus returns parsed JSON on success", async () => {
    const payload = { gateway: "running" };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    const result = await api.fetchStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/status",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual(payload);
    expect(window.location.href).toBe("http://localhost/");
  });

  it("reads and acknowledges advanced Control UI access", async () => {
    const api = await loadApiModule();
    global.fetch
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          ok: true,
          acknowledged: false,
          warningVersion: "teamyou.advanced-control-warning/v1",
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          ok: true,
          acknowledged: true,
          url: "/openclaw/#/dashboard",
        }),
      );

    await expect(api.fetchAdvancedControlAccessStatus()).resolves.toMatchObject({
      acknowledged: false,
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/advanced-control/status",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );

    await expect(
      api.acknowledgeAdvancedControlAccess("/openclaw/#/dashboard"),
    ).resolves.toMatchObject({ acknowledged: true });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/advanced-control/acknowledge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ returnTo: "/openclaw/#/dashboard" }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
  });

  it("refreshModels requests hosted metadata and provider discovery together", async () => {
    const payload = { ok: true, scope: "all", restartRequired: true };
    global.fetch.mockResolvedValue(mockJsonResponse(200, payload));
    const api = await loadApiModule();

    await expect(api.refreshModels()).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/models/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
  });

  it("redirects to /setup and throws on 401", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(401, { error: "Unauthorized" }));
    const api = await loadApiModule();

    await expect(api.fetchStatus()).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/setup");
  });

  it("runOnboard sends vars, modelKey, and runtime payload", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const api = await loadApiModule();
    const vars = [{ key: "OPENAI_API_KEY", value: "sk-123" }];
    const modelKey = "openai/gpt-5.1-codex";

    const result = await api.runOnboard(vars, modelKey, {
      agentRuntimeId: "codex",
      tailscaleApiToken: "tskey-api-test_123456789",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboard",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          vars,
          modelKey,
          agentRuntimeId: "codex",
          tailscaleApiToken: "tskey-api-test_123456789",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true });
  });

  it("runOnboard marks empty final responses as interrupted", async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => "",
    });
    const api = await loadApiModule();

    await expect(api.runOnboard([], "openai/gpt-5.1-codex")).rejects.toMatchObject({
      code: "ONBOARD_RESPONSE_EMPTY",
    });
  });

  it("saveEnvVars uses PUT with expected request body", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, changed: true }));
    const api = await loadApiModule();
    const vars = [{ key: "GITHUB_TOKEN", value: "ghp_123" }];

    const result = await api.saveEnvVars(vars);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/env",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ vars }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, changed: true });
  });

  it("saveEnvVars throws server error on non-OK response", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(400, { error: "Reserved env var" }));
    const api = await loadApiModule();

    await expect(api.saveEnvVars([{ key: "PORT", value: "3000" }])).rejects.toThrow(
      "Reserved env var",
    );
  });

  it("approveDevice encodes ids and throws API errors", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(403, { ok: false, error: "missing scope" }));
    const api = await loadApiModule();

    await expect(api.approveDevice("req/admin 1")).rejects.toThrow("missing scope");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/devices/req%2Fadmin%201/approve",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
  });

  it("fetchUsageSummary calls usage summary endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, summary: { daily: [] } }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSummary(90);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/summary?days=90",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, summary: { daily: [] } });
  });

  it("fetchUsageSessions calls usage sessions endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, sessions: [] }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSessions(100);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/sessions?limit=100",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it("fetchDoctorStatus calls Doctor status endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, status: { stale: true } }));
    const api = await loadApiModule();

    const result = await api.fetchDoctorStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/status",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, status: { stale: true } });
  });

  it("fetchDoctorCards calls aggregated Doctor cards endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, cards: [] }));
    const api = await loadApiModule();

    const result = await api.fetchDoctorCards({ runId: "all" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/cards?runId=all",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, cards: [] });
  });

  it("startDoctorRun posts to the Doctor run endpoint", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(202, { ok: true, runId: 42 }));
    const api = await loadApiModule();

    const result = await api.startDoctorRun();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, runId: 42 });
  });

  it("importDoctorResult posts raw Doctor output", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(201, { ok: true, runId: 43 }));
    const api = await loadApiModule();

    const result = await api.importDoctorResult('{"summary":"Imported","cards":[]}');

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rawOutput: '{"summary":"Imported","cards":[]}' }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, runId: 43 });
  });

  it("fetchUsageSessionDetail encodes session id in path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, detail: { sessionId: "x" } }));
    const api = await loadApiModule();

    const result = await api.fetchUsageSessionDetail("agent:main:telegram:group:-1:topic:2");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/usage/sessions/agent%3Amain%3Atelegram%3Agroup%3A-1%3Atopic%3A2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, detail: { sessionId: "x" } });
  });

  it("sendDoctorCardFix posts delivery fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, stdout: "sent" }));
    const api = await loadApiModule();

    const result = await api.sendDoctorCardFix({
      cardId: 7,
      sessionId: "session-123",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Use a more focused fix request",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/doctor/findings/7/fix",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-123",
          replyChannel: "telegram",
          replyTo: "1050",
          prompt: "Use a more focused fix request",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, stdout: "sent" });
  });

  it("createWebhook posts optional destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(201, { ok: true, webhook: { name: "gmail" } }));
    const api = await loadApiModule();

    const result = await api.createWebhook("gmail-alerts", {
      destination: {
        channel: "telegram",
        to: "-1003709908795:4011",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/webhooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "gmail-alerts",
          destination: {
            channel: "telegram",
            to: "-1003709908795:4011",
          },
          oauthCallback: false,
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, webhook: { name: "gmail" } });
  });

  it("updateWebhookDestination puts destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, webhook: { name: "gmail-alerts" } }));
    const api = await loadApiModule();

    const result = await api.updateWebhookDestination("gmail-alerts", {
      destination: {
        channel: "telegram",
        to: "1050",
        agentId: "main",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/webhooks/gmail-alerts/destination",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          destination: {
            channel: "telegram",
            to: "1050",
            agentId: "main",
          },
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, webhook: { name: "gmail-alerts" } });
  });

  it("startGmailWatch posts optional destination fields", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, accountId: "acct-1" }));
    const api = await loadApiModule();

    const result = await api.startGmailWatch("acct-1", {
      destination: {
        channel: "telegram",
        to: "1050",
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/gmail/watch/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "acct-1",
          destination: {
            channel: "telegram",
            to: "1050",
          },
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true, accountId: "acct-1" });
  });

  it("fetchBrowseTree defaults to a bounded tree depth", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, tree: [] }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=3",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, tree: [] });
  });

  it("fetchBrowseTree requests a folder subtree by path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, root: {} }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree({
      path: "workspace/hooks/bootstrap",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=3&path=workspace%2Fhooks%2Fbootstrap",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, root: {} });
  });

  it("fetchBrowseTree preserves numeric depth calls", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, root: {} }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseTree(2);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/tree?depth=2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, root: {} });
  });

  it("fetchBrowseFileDiff calls git diff endpoint with encoded path", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true, content: "diff --git" }));
    const api = await loadApiModule();

    const result = await api.fetchBrowseFileDiff("workspace/hooks/bootstrap/AGENTS.md");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/git-diff?path=workspace%2Fhooks%2Fbootstrap%2FAGENTS.md",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({ ok: true, content: "diff --git" });
  });

  it("downloadBrowseFile calls download endpoint and triggers browser download", async () => {
    const fileBlob = new Blob(["test"], { type: "text/plain" });
    const createObjectURL = vi.fn(() => "blob:test-url");
    const revokeObjectURL = vi.fn();
    global.window.URL = { createObjectURL, revokeObjectURL };
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    global.document = {
      createElement: vi.fn((tagName) =>
        tagName === "a"
          ? {
              href: "",
              download: "",
              click,
              remove,
            }
          : {},
      ),
      body: { appendChild },
    };
    global.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      blob: async () => fileBlob,
      text: async () => "",
    });
    const api = await loadApiModule();

    const result = await api.downloadBrowseFile("workspace/file.txt");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/browse/download?path=workspace%2Ffile.txt",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(fileBlob);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
    expect(result).toEqual({ ok: true });
  });

  it("createChannelAccount posts provider, token, and agent binding fields", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(201, {
        ok: true,
        channel: "telegram",
        account: { id: "alerts", envKey: "TELEGRAM_BOT_TOKEN_ALERTS" },
      }),
    );
    const api = await loadApiModule();

    const result = await api.createChannelAccount({
      provider: "telegram",
      name: "Alerts",
      accountId: "alerts",
      token: "123:abc",
      agentId: "ops",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "telegram",
          name: "Alerts",
          accountId: "alerts",
          token: "123:abc",
          agentId: "ops",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      account: { id: "alerts", envKey: "TELEGRAM_BOT_TOKEN_ALERTS" },
    });
  });

  it("updateChannelAccount posts editable channel fields", async () => {
    global.fetch.mockResolvedValue(
      mockJsonResponse(200, {
        ok: true,
        channel: "telegram",
        account: { id: "alerts", name: "Alerts Bot", boundAgentId: "main" },
      }),
    );
    const api = await loadApiModule();

    const result = await api.updateChannelAccount({
      provider: "telegram",
      accountId: "alerts",
      name: "Alerts Bot",
      agentId: "main",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          provider: "telegram",
          accountId: "alerts",
          name: "Alerts Bot",
          agentId: "main",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      account: { id: "alerts", name: "Alerts Bot", boundAgentId: "main" },
    });
  });

  it("deleteChannelAccount sends provider and account id", async () => {
    global.fetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const api = await loadApiModule();

    const result = await api.deleteChannelAccount({
      provider: "telegram",
      accountId: "alerts",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/channels/accounts",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          provider: "telegram",
          accountId: "alerts",
        }),
        headers: expect.any(Headers),
      }),
    );
    expectLastFetchHeaders("application/json");
    expect(result).toEqual({ ok: true });
  });
});
