const {
  normalizeThinkingDefaultValue,
  resolveThinkingOptionsForModel,
} = require("../../lib/server/openclaw-thinking");

describe("OpenClaw thinking compatibility", () => {
  it.each([
    ["high", "high"],
    ["auto", "adaptive"],
    ["extra high", "xhigh"],
    ["ultrathink", "high"],
    ["invalid", null],
  ])("normalizes %s with the pinned OpenClaw helper", async (raw, expected) => {
    await expect(normalizeThinkingDefaultValue(raw)).resolves.toBe(expected);
  });

  it("loads thinking options from the pinned OpenClaw public behavior", async () => {
    const result = await resolveThinkingOptionsForModel({
      modelKey: "openai/gpt-5.5",
      catalog: [
        {
          provider: "openai",
          id: "gpt-5.5",
          reasoning: true,
        },
      ],
    });

    expect(result.levels.map((entry) => entry.id)).toContain("high");
    expect(result.modelDefault).toBeTruthy();
  });
});
