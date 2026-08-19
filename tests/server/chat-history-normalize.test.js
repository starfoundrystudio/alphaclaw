const {
  normalizeHistoryMessages,
  isConnectionLevelError,
  kAlphaclawSystemNotePrefix,
} = require("../../lib/server/chat-ws");
const { kBootstrapKickoffMessage } = require("../../lib/server/bootstrap-kickoff");

describe("server/chat-ws normalizeHistoryMessages", () => {
  it("hides AlphaClaw system notes from the rendered transcript", () => {
    const rawMessages = [
      { role: "user", content: kBootstrapKickoffMessage, timestamp: 1 },
      { role: "assistant", content: "Hey. I just came online.", timestamp: 2 },
      { role: "user", content: "Hi there!", timestamp: 3 },
    ];

    const { messages } = normalizeHistoryMessages(rawMessages, { messages: rawMessages });

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Hey. I just came online."],
      ["user", "Hi there!"],
    ]);
  });

  it("keeps the kickoff message aligned with the hidden-note marker", () => {
    expect(kBootstrapKickoffMessage.startsWith(kAlphaclawSystemNotePrefix)).toBe(
      true,
    );
  });

  it("still strips other bracket prefixes from visible user messages", () => {
    const rawMessages = [
      { role: "user", content: "[telegram] hello from telegram", timestamp: 1 },
    ];

    const { messages } = normalizeHistoryMessages(rawMessages, null);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("hello from telegram");
  });

  it("classifies gateway-reachability failures as connection-level", () => {
    expect(
      isConnectionLevelError(new Error("connect ECONNREFUSED 127.0.0.1:18789")),
    ).toBe(true);
    expect(
      isConnectionLevelError(new Error("OpenClaw gateway is not connected")),
    ).toBe(true);
    expect(
      isConnectionLevelError(new Error("OpenClaw chat.history request timed out")),
    ).toBe(true);
    expect(
      isConnectionLevelError(new Error("gateway request failed: bad params")),
    ).toBe(false);
    expect(isConnectionLevelError(new Error("Something went wrong."))).toBe(
      false,
    );
  });

  it("does not hide assistant messages that quote the marker", () => {
    const rawMessages = [
      {
        role: "assistant",
        content: `${kAlphaclawSystemNotePrefix} looks like a system note`,
        timestamp: 1,
      },
    ];

    const { messages } = normalizeHistoryMessages(rawMessages, null);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });
});
