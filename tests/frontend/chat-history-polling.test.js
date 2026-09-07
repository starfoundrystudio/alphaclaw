import { describe, it, expect } from "vitest";
import {
  shouldPollChatHistory,
  createChatHistoryPollTracker,
} from "../../lib/public/js/lib/chat-history-polling.js";

describe("background chat history polling", () => {
  it("follows a greeting through tool activity and partial text until its final history", () => {
    expect(shouldPollChatHistory({ messages: [] })).toBe(true);
    const rawHistory = { sessionInfo: { hasActiveRun: true } };
    const messages = [{ role: "tool", content: "Tool call: read" }];
    expect(shouldPollChatHistory({ messages, rawHistory })).toBe(true);
    messages.push({ role: "assistant", content: "Let me check your setup." });
    expect(shouldPollChatHistory({ messages, rawHistory })).toBe(true);
    messages.push({ role: "assistant", content: "Hello, let’s get started." });
    rawHistory.sessionInfo.hasActiveRun = false;
    expect(shouldPollChatHistory({ messages, rawHistory })).toBe(false);
  });

  it.each(["sending", "streaming"])(
    "leaves browser-owned %s to its live stream",
    (flag) => {
      expect(
        shouldPollChatHistory({
          messages: [],
          sessionKey: "main",
          browserRunSessionKey: "main",
          rawHistory: { sessionInfo: { hasActiveRun: true } },
          [flag]: true,
        }),
      ).toBe(false);
    },
  );

  it("does not keep polling ordinary idle conversations", () => {
    expect(
      shouldPollChatHistory({ messages: [{ role: "user", content: "Hi" }] }),
    ).toBe(false);
  });
});

describe("idle history confirmation", () => {
  const partial = {
    messages: [{ role: "tool", content: "Tool call: read" }],
    rawHistory: { sessionInfo: { hasActiveRun: false } },
  };
  const complete = {
    messages: [{ role: "assistant", content: "Hello" }],
    rawHistory: { sessionInfo: { hasActiveRun: false } },
  };

  it("requires a newly issued request after idle, even when prior requests overlap", () => {
    const tracker = createChatHistoryPollTracker();
    const first = tracker.beginRequest("main");
    const overlapping = tracker.beginRequest("main");
    expect(tracker.observeResponse("main", first, partial)).toBe(true);
    expect(tracker.observeResponse("main", overlapping, partial)).toBe(true);
    expect(
      shouldPollChatHistory({ ...partial, needsReconciliation: true }),
    ).toBe(true);
    const confirmation = tracker.beginRequest("main");
    expect(tracker.observeResponse("main", confirmation, complete)).toBe(false);
    expect(tracker.observeResponse("main", overlapping, partial)).toBe(false);
  });

  it("resets confirmation if a run resumes and tracks sessions separately", () => {
    const tracker = createChatHistoryPollTracker();
    expect(
      tracker.observeResponse("main", tracker.beginRequest("main"), partial),
    ).toBe(true);
    expect(
      tracker.observeResponse("main", tracker.beginRequest("main"), {
        ...partial,
        rawHistory: { sessionInfo: { hasActiveRun: true } },
      }),
    ).toBe(true);
    expect(
      tracker.observeResponse("main", tracker.beginRequest("main"), complete),
    ).toBe(true);
    expect(
      tracker.observeResponse("other", tracker.beginRequest("other"), complete),
    ).toBe(true);
    expect(
      tracker.observeResponse("main", tracker.beginRequest("main"), complete),
    ).toBe(false);
    expect(
      tracker.observeResponse("other", tracker.beginRequest("other"), complete),
    ).toBe(false);
  });
});

it("keeps idle confirmation through late overlapping responses and rearms explicit cycles", () => {
  const tracker = createChatHistoryPollTracker();
  const idle = {
    messages: [{ role: "assistant", content: "Hello" }],
    rawHistory: { sessionInfo: { hasActiveRun: false } },
  };
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), idle),
  ).toBe(true);
  const confirmation = tracker.beginRequest("main");
  const overlapping = tracker.beginRequest("main");
  expect(tracker.observeResponse("main", confirmation, idle)).toBe(false);
  expect(tracker.observeResponse("main", overlapping, idle)).toBe(false);
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), idle),
  ).toBe(false);
  const nextCycle = tracker.beginRequest("main", { reconcile: true });
  expect(tracker.observeResponse("main", overlapping, idle)).toBe(true);
  expect(tracker.observeResponse("main", nextCycle, idle)).toBe(true);
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), idle),
  ).toBe(false);
});

it("does not pause a selected chat for a browser stream in another session", () => {
  expect(
    shouldPollChatHistory({
      messages: [],
      sessionKey: "other",
      browserRunSessionKey: "main",
      sending: true,
      streaming: true,
    }),
  ).toBe(true);
  expect(
    shouldPollChatHistory({
      messages: [],
      sessionKey: "main",
      browserRunSessionKey: "main",
      streaming: true,
    }),
  ).toBe(false);
});

it("confirms fresh history after a disconnected browser run falls back to HTTP", () => {
  const tracker = createChatHistoryPollTracker();
  const idle = {
    messages: [{ role: "assistant", content: "previous reply" }],
    rawHistory: { sessionInfo: { hasActiveRun: false } },
  };
  tracker.observeResponse("main", tracker.beginRequest("main"), idle);
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), idle),
  ).toBe(false);
  tracker.startCycle("main"); // socket close discards browser ownership
  const partial = {
    ...idle,
    messages: [{ role: "tool", content: "Tool call: read" }],
  };
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), partial),
  ).toBe(true);
  expect(
    tracker.observeResponse("main", tracker.beginRequest("main"), {
      ...idle,
      messages: [{ role: "assistant", content: "completed reply" }],
    }),
  ).toBe(false);
});
