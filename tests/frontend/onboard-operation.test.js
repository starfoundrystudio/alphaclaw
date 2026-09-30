const loadModule = async () =>
  import("../../lib/public/js/components/welcome/onboard-operation.js");

// A scripted subscribeOperationEvents: each subscription plays the next
// script (a list of { event, data } entries, or "disconnect").
const createSubscribe = (scripts) => {
  const calls = [];
  const subscribe = vi.fn(({ operationId, onMessage, onError }) => {
    const script = scripts[calls.length] || ["disconnect"];
    calls.push(operationId);
    const close = vi.fn();
    queueMicrotask(() => {
      for (const step of script) {
        if (step === "disconnect") {
          onError(new Event("error"));
          return;
        }
        onMessage(step);
      }
    });
    return close;
  });
  return { subscribe, calls };
};

const noWait = async () => {};

describe("frontend/onboard-operation", () => {
  it("reports progress labels and resolves with the done payload", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe } = createSubscribe([
      [
        { event: "phase", data: { phase: "configuring", label: "Configuring OpenClaw" } },
        { event: "phase", data: { phase: "finishing", label: "Finishing setup" } },
        { event: "done", data: { ok: true, setupUrl: "https://a.teamyou.io" } },
      ],
    ]);
    const onProgress = vi.fn();

    await expect(
      followOnboardOperation({ operationId: "op-1", onProgress, subscribe }),
    ).resolves.toEqual({ ok: true, setupUrl: "https://a.teamyou.io" });
    expect(onProgress.mock.calls.map(([label]) => label)).toEqual([
      "Configuring OpenClaw",
      "Finishing setup",
    ]);
  });

  it("surfaces a server error message", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe } = createSubscribe([
      [{ event: "error", data: { error: "Model provider authentication failed." } }],
    ]);

    await expect(
      followOnboardOperation({ operationId: "op-1", subscribe }),
    ).rejects.toThrow("Model provider authentication failed.");
  });

  it("treats a data-less error event as a disconnect and finishes via status", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe } = createSubscribe([[{ event: "error", data: {} }]]);
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("service restarting"))
      .mockResolvedValueOnce({ onboarded: true, setupUrl: "https://a.teamyou.io" });

    await expect(
      followOnboardOperation({
        operationId: "op-1",
        subscribe,
        fetchStatus,
        wait: noWait,
      }),
    ).resolves.toEqual({ onboarded: true, setupUrl: "https://a.teamyou.io" });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("re-attaches while the server still reports the operation running", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe, calls } = createSubscribe([
      ["disconnect"],
      [{ event: "done", data: { ok: true, setupUrl: "https://a.teamyou.io" } }],
    ]);
    const fetchStatus = vi.fn(async () => ({
      onboarded: false,
      onboardingOperation: { operationId: "op-1" },
    }));

    await expect(
      followOnboardOperation({ operationId: "op-1", subscribe, fetchStatus, wait: noWait }),
    ).resolves.toEqual({ ok: true, setupUrl: "https://a.teamyou.io" });
    expect(calls).toEqual(["op-1", "op-1"]);
  });

  it("replays once for a settled operation, then reports the interruption", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe, calls } = createSubscribe([["disconnect"], ["disconnect"]]);
    const fetchStatus = vi.fn(async () => ({ onboarded: false }));

    await expect(
      followOnboardOperation({ operationId: "op-1", subscribe, fetchStatus, wait: noWait }),
    ).rejects.toThrow("Setup was interrupted before it finished. Please retry.");
    expect(calls).toHaveLength(2);
  });

  it("gives up when the server never answers again", async () => {
    const { followOnboardOperation } = await loadModule();
    const { subscribe } = createSubscribe([["disconnect"]]);
    const fetchStatus = vi.fn(async () => {
      throw new Error("down");
    });

    await expect(
      followOnboardOperation({
        operationId: "op-1",
        subscribe,
        fetchStatus,
        wait: noWait,
        statusPollAttempts: 3,
      }),
    ).rejects.toThrow("Setup was interrupted");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("treats a missing EventSource as a disconnect", async () => {
    const { streamOnboardOperationOnce } = await loadModule();
    await expect(
      streamOnboardOperationOnce({
        operationId: "op-1",
        subscribe: () => {
          throw new Error("Server events are not supported in this browser");
        },
      }),
    ).resolves.toEqual({ type: "disconnected" });
  });

  it("starts setup and follows the returned operation", async () => {
    const { startAndFollowOnboard } = await loadModule();
    const start = vi.fn(async () => ({ ok: true, operationId: "op-9" }));
    const follow = vi.fn(async () => ({ ok: true, setupUrl: "https://a.teamyou.io" }));
    const onProgress = vi.fn();

    await expect(
      startAndFollowOnboard({
        vars: [{ key: "OPENAI_API_KEY", value: "sk" }],
        modelKey: "openai/gpt-5.5",
        tailscaleApiToken: "",
        onProgress,
        start,
        follow,
      }),
    ).resolves.toEqual({ ok: true, setupUrl: "https://a.teamyou.io" });
    expect(start).toHaveBeenCalledWith(
      [{ key: "OPENAI_API_KEY", value: "sk" }],
      "openai/gpt-5.5",
      { agentRuntimeId: null, tailscaleApiToken: "" },
    );
    expect(follow).toHaveBeenCalledWith({ operationId: "op-9", onProgress });
  });

  it("rejects a refused start with the server error", async () => {
    const { startAndFollowOnboard } = await loadModule();
    await expect(
      startAndFollowOnboard({
        start: async () => ({ ok: false, error: "Already onboarded" }),
      }),
    ).rejects.toThrow("Already onboarded");
  });
});
