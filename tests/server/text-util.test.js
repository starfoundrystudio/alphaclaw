const { stripAnsi } = require("../../lib/server/utils/text");

const ESC = "\u001b";

describe("server/utils/text", () => {
  it("strips ANSI style sequences and stray escapes", () => {
    expect(stripAnsi(`${ESC}[2mUpdate${ESC}[22m ${ESC}[96mv2${ESC}[39m`)).toBe(
      "Update v2",
    );
    expect(stripAnsi(`${ESC}[40m boom ${ESC}[49m`)).toBe(" boom ");
    expect(stripAnsi(`${ESC} stray`)).toBe(" stray");
    expect(stripAnsi("plain  text")).toBe("plain  text");
  });

  it("strips private-mode CSI and OSC sequences (Codex review finding)", () => {
    // Cursor-hide — seen in real composio CLI TTY output as ESC[?25l
    expect(stripAnsi(`${ESC}[?25l spinner ${ESC}[?25h`)).toBe(" spinner ");
    // OSC hyperlink with BEL terminator
    expect(
      stripAnsi(`${ESC}]8;;https://example.com${"\u0007"}link${ESC}]8;;${"\u0007"}`),
    ).toBe("link");
  });

  it("preserves non-escape bracketed text", () => {
    expect(stripAnsi("[info] keep [2026-07-23] this")).toBe(
      "[info] keep [2026-07-23] this",
    );
  });
});
