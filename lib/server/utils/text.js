const { stripVTControlCharacters } = require("util");

// Strip ANSI/VT terminal control sequences (colors, cursor controls, OSC
// hyperlinks, etc.) and stray escape bytes from CLI output destined for
// user-facing display or logs. Node's built-in sanitizer covers the full VT
// grammar (SGR, private-mode CSI like ESC[?25l, OSC), unlike a simple SGR
// regex; the trailing replace drops any orphaned escape bytes it leaves.
const stripAnsi = (text = "") =>
  stripVTControlCharacters(String(text || "")).replace(/[\u001b\u0007]/g, "");

module.exports = { stripAnsi };
