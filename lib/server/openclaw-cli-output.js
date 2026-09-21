"use strict";

// OpenClaw 2026.9 prints config-validation warnings and maintenance notices
// on stderr even when a command succeeds (e.g. 26 "plugins.deny: plugin not
// found …" fragments per call before finding #20 was fixed, "Removed retired
// agents.entries.*.default markers", deferred plugin validation). npm adds
// its own "npm warn" lines. None of that is the reason a command failed, and
// showing it to a user buries the real error. Strip it before classifying a
// failure or putting output in front of anyone; keep the raw text for logs.

const kAnsiPattern = /\[[0-9;]*m/g;

const kNoiseLinePatterns = [
  /^\s*\[config\]\s*warnings:/i,
  /^\s*config warnings:/i,
  /^\s*config \([^)]*\):/i,
  /^\s*npm warn\b/i,
  /^\s*\[proxy\]\s/i,
  /^\s*\[alphaclaw\]\s/i,
];

const stripOpenclawNoise = (text = "") =>
  String(text || "")
    .replace(kAnsiPattern, "")
    .split(/\r?\n/)
    .filter((line) => !kNoiseLinePatterns.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();

// A short, user-facing reason for a failed OpenClaw command. `result` is a
// clawCmd result or a thrown child_process error.
const summarizeOpenclawFailure = (result = {}, { fallback = "OpenClaw command failed" } = {}) => {
  const timedOut =
    result?.timedOut === true ||
    (result?.killed === true && /SIGTERM|SIGKILL/.test(String(result?.signal || ""))) ||
    /ETIMEDOUT/.test(String(result?.code || ""));
  const cleaned = [result?.stderr, result?.stdout]
    .map((part) => stripOpenclawNoise(part))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (timedOut) {
    return cleaned
      ? `OpenClaw did not finish in time: ${cleaned.slice(0, 400)}`
      : "OpenClaw did not finish in time. Try again in a moment.";
  }
  if (cleaned) return cleaned.slice(0, 600);
  const message = stripOpenclawNoise(result?.message || "");
  // A child_process message starts with "Command failed: <full command line>";
  // do not echo command lines (they can carry tokens).
  if (message && !/^command failed:/i.test(message)) return message.slice(0, 600);
  return fallback;
};

module.exports = {
  stripOpenclawNoise,
  summarizeOpenclawFailure,
};
