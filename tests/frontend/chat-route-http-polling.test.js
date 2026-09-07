import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ effects: [], states: [], authFetch: vi.fn() }));
vi.mock("preact/hooks", () => ({
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  useRef: (current) => ({ current }),
  useLayoutEffect: () => {},
  useEffect: (effect) => harness.effects.push(effect),
  useState: (initial) => {
    const state = { value: typeof initial === "function" ? initial() : initial };
    harness.states.push(state);
    return [state.value, (next) => {
      state.value = typeof next === "function" ? next(state.value) : next;
    }];
  },
}));
vi.mock("../../lib/public/js/lib/api.js", () => ({ authFetch: harness.authFetch }));
vi.mock("../../lib/public/js/components/channel-setup-callout.js", () => ({
  ChannelSetupCallout: () => null,
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({ showToast: vi.fn() }));
import { ChatRoute } from "../../lib/public/js/components/routes/chat-route.js";

let cleanups = [];
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup?.());
  cleanups = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat route HTTP fallback polling", () => {
  it("lets a six-second history read finish before scheduling the next five-second poll", async () => {
    vi.useFakeTimers();
    harness.effects = [];
    harness.states = [];
    harness.authFetch.mockReset();
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.test", search: "" } });
    vi.stubGlobal("document", { hidden: false });
    const sockets = [];
    vi.stubGlobal("WebSocket", class {
      constructor() { sockets.push(this); }
      readyState = 0;
      close() {}
      send() {}
    });
    harness.authFetch.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true,
        json: async () => ({
          messages: [{ role: "assistant", content: "Your complete onboarding greeting" }],
          rawHistory: { sessionInfo: { hasActiveRun: false } },
        }),
      }), 6000);
    }));
    ChatRoute({ selectedSessionKey: "main" });
    cleanups = harness.effects.map((effect) => effect());
    const pollTick = harness.states.find((state) => state.value === 0);
    expect(harness.authFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pollTick.value).toBe(0); // no effect teardown while HTTP is pending
    const reconciliation = harness.states.find((state) => state.value?.main === true);
    const pendingCycle = reconciliation.value;
    sockets[0].onclose(); // a failed upgrade must preserve the in-flight HTTP cycle
    expect(reconciliation.value).toBe(pendingCycle);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.states[0].value.main[0].content).toBe("Your complete onboarding greeting");
    await vi.advanceTimersByTimeAsync(4000);
    expect(pollTick.value).toBe(1); // confirmation can now request another snapshot
    sockets.at(-1).onopen();
    const connectedCycle = reconciliation.value;
    sockets.at(-1).onclose(); // an established stream does require fresh confirmation
    expect(reconciliation.value).not.toBe(connectedCycle);
  });
});

it("preserves completed tool results when an older WebSocket history response arrives late", async () => {
  vi.useFakeTimers();
  harness.effects = [];
  harness.states = [];
  harness.authFetch.mockReset();
  harness.authFetch.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("window", { location: { protocol: "https:", host: "example.test", search: "" } });
  vi.stubGlobal("document", { hidden: false });
  const sockets = [];
  const requests = [];
  vi.stubGlobal("WebSocket", class {
    constructor() { sockets.push(this); }
    readyState = 0;
    close() {}
    send(message) { requests.push(JSON.parse(message)); }
  });
  ChatRoute({ selectedSessionKey: "main" });
  cleanups = harness.effects.map((effect) => effect());
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen();
  await vi.advanceTimersByTimeAsync(10000);
  expect(requests).toHaveLength(3);
  const deliver = (request, complete) => ws.onmessage({ data: JSON.stringify({
    type: "history", sessionKey: "main", historyRequestId: request.historyRequestId,
    messages: [{
      role: "tool", content: "Tool call: read", timestamp: 100,
      toolResult: complete ? { text: "Setup verified" } : null,
    }],
    rawHistory: { sessionInfo: { hasActiveRun: false }, complete },
  }) });
  deliver(requests[1], true);
  // Confirmation must be issued after the idle reply, not already in flight.
  await vi.advanceTimersByTimeAsync(5000);
  deliver(requests[3], true);
  const completedMessages = harness.states[0].value;
  const rawHistory = harness.states.find((state) => state.value?.main?.complete === true);
  const completedRaw = rawHistory.value;
  deliver(requests[0], false);
  expect(harness.states[0].value).toBe(completedMessages);
  expect(harness.states[0].value.main[0].debugPayload.toolResult.text).toBe("Setup verified");
  expect(rawHistory.value).toBe(completedRaw);
});
