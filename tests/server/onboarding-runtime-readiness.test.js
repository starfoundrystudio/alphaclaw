const {
  createOnboardingRuntimeReadiness,
} = require("../../lib/server/onboarding/runtime-readiness");

const setup = () => {
  const state = {
    gatewayRunning: true,
    restartRequired: false,
    restartInProgress: false,
    updatedAt: 1,
  };
  const deps = {
    getRestartSnapshot: vi.fn(async () => ({ ...state })),
    isAgentVaultReady: vi.fn(async () => true),
    requestGateway: vi.fn(async () => ({ messages: [] })),
  };
  return { state, ...deps, ready: createOnboardingRuntimeReadiness(deps) };
};

describe("onboarding runtime readiness", () => {
  it("waits for authenticated chat despite a listening port, then recovers", async () => {
    const check = setup();
    check.requestGateway.mockRejectedValueOnce(
      new Error("gateway starting; retry shortly"),
    );
    expect(await check.ready()).toBe(false);
    expect(await check.ready()).toBe(true);
    expect(check.requestGateway).toHaveBeenLastCalledWith(
      "chat.history",
      { sessionKey: "main", limit: 1 },
      3000,
    );
  });

  it("leaves imported default-agent and global-session resolution to OpenClaw", async () => {
    const check = setup();
    check.requestGateway.mockImplementation(async (_method, params) => {
      // OpenClaw rejects a literal main agent for a global session whose only
      // configured agent is ops. Its main alias resolves that default instead.
      if (params.sessionKey !== "main" || params.agentId) {
        throw new Error('Unknown agent id "main"');
      }
      return { sessionKey: "global", messages: [] };
    });
    expect(await check.ready()).toBe(true);
  });

  it("waits for Vault enrollment and discovery before probing chat", async () => {
    const check = setup();
    check.isAgentVaultReady.mockResolvedValueOnce(false);
    expect(await check.ready()).toBe(false);
    expect(check.requestGateway).not.toHaveBeenCalled();
    expect(await check.ready()).toBe(true);
  });

  it.each(["restartRequired", "restartInProgress"])(
    "waits while %s is set",
    async (flag) => {
      const check = setup();
      check.state[flag] = true;
      expect(await check.ready()).toBe(false);
      expect(check.requestGateway).not.toHaveBeenCalled();
    },
  );

  it("rejects a restart that begins or completes during the chat check", async () => {
    const check = setup();
    check.requestGateway.mockImplementationOnce(async () => {
      check.state.updatedAt = 2;
    });
    expect(await check.ready()).toBe(false);
    expect(await check.ready()).toBe(true);
  });

  it("coalesces concurrent image probes and never returns private history", async () => {
    const check = setup();
    let release;
    check.requestGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = check.ready();
    const second = check.ready();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release({ messages: [{ content: "private history" }] });
    expect(await first).toBe(true);
    expect(check.requestGateway).toHaveBeenCalledTimes(1);
  });

  it("fails closed on discovery and restart-state errors", async () => {
    const check = setup();
    check.isAgentVaultReady.mockRejectedValueOnce(new Error("Vault down"));
    expect(await check.ready()).toBe(false);
    check.getRestartSnapshot.mockRejectedValueOnce(
      new Error("state unavailable"),
    );
    expect(await check.ready()).toBe(false);
  });
});
