import { describe, expect, it } from "vitest";
import { mergeHistoryMessages } from "../../lib/public/js/lib/chat-history-merge.js";

const msg = (role, content, createdAt) => ({ role, content, createdAt });

describe("mergeHistoryMessages", () => {
  it("returns the snapshot when there is no local state", () => {
    const history = [msg("assistant", "Hey. I just came online.", 100)];
    expect(mergeHistoryMessages([], history)).toEqual(history);
    expect(mergeHistoryMessages(undefined, history)).toEqual(history);
  });

  it("keeps optimistic local messages a stale snapshot is missing", () => {
    const local = [
      msg("assistant", "Hey. I just came online.", 100),
      msg("user", "Hi! Please call yourself Rosebud.", 200),
      msg("assistant", "Rosebud it is.", 250),
    ];
    // Snapshot lost the persistence race: only contains the greeting.
    const history = [msg("assistant", "Hey. I just came online.", 100)];

    expect(mergeHistoryMessages(local, history)).toEqual([
      msg("assistant", "Hey. I just came online.", 100),
      msg("user", "Hi! Please call yourself Rosebud.", 200),
      msg("assistant", "Rosebud it is.", 250),
    ]);
  });

  it("does not duplicate messages present in both local state and snapshot", () => {
    const local = [
      msg("user", "Hi there!", 200),
      msg("assistant", "Hello!", 300),
    ];
    // Server assigned its own (later) timestamps when persisting.
    const history = [
      msg("user", "Hi there!", 210),
      msg("assistant", "Hello!", 310),
    ];

    expect(mergeHistoryMessages(local, history)).toEqual(history);
  });

  it("prefers the snapshot when it is complete and newer", () => {
    const local = [msg("user", "Hi there!", 200)];
    const history = [
      msg("user", "Hi there!", 210),
      msg("assistant", "Hello!", 310),
      msg("assistant", "Anything else?", 320),
    ];

    expect(mergeHistoryMessages(local, history)).toEqual(history);
  });

  it("keeps local state when the snapshot is empty", () => {
    const local = [msg("user", "First message ever", 200)];
    expect(mergeHistoryMessages(local, [])).toEqual(local);
  });

  it("does not let repeated old tool rows swallow new local tool rows", () => {
    const history = [];
    for (let i = 0; i < 15; i += 1) {
      history.push(msg("tool", "Tool call: exec", 100 + i));
      history.push(msg("assistant", `result ${i}`, 100 + i));
    }
    const local = [...history, msg("tool", "Tool call: exec", 500)];

    const merged = mergeHistoryMessages(local, history);
    expect(merged[merged.length - 1]).toEqual(msg("tool", "Tool call: exec", 500));
  });

  it("drops a stale local tail message that the recent snapshot already has", () => {
    const local = [msg("user", "Hi there!", 400)];
    const history = [
      msg("assistant", "Earlier reply", 100),
      msg("user", "Hi there!", 350),
    ];

    expect(mergeHistoryMessages(local, history)).toEqual(history);
  });
});
