/**
 * Presentation helpers for the security-gateway hop indicator. The server
 * reduces the host probe file to `watchdogStatus.gatewayHop`; this module only
 * turns that snapshot into a label, a detail line and a status tone.
 */

const kHiddenStates = new Set(["", "unavailable", "not_applicable"]);

export const kGatewayHopDotClasses = {
  healthy: "ac-status-dot ac-status-dot--healthy ac-status-dot--healthy-offset",
  warning: "bg-yellow-500",
  danger: "bg-red-500",
  unknown: "bg-gray-500",
};

export const formatRelativeAge = (ageMs) => {
  if (ageMs == null || ageMs === "") return "unknown";
  const safeMs = Number(ageMs);
  if (!Number.isFinite(safeMs) || safeMs < 0) return "unknown";
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const resolveCheckedAgeMs = (gatewayHop, nowMs) => {
  const checkedAtMs = Date.parse(String(gatewayHop?.checkedAt || ""));
  if (Number.isFinite(checkedAtMs) && Number.isFinite(nowMs)) {
    return Math.max(0, nowMs - checkedAtMs);
  }
  const reported = Number(gatewayHop?.checkedAgeMs);
  return Number.isFinite(reported) && reported >= 0 ? reported : null;
};

const pluralize = (count, noun) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const describeGatewayHopStatus = (gatewayHop, nowMs = Date.now()) => {
  const state = String(gatewayHop?.state || "");
  if (!gatewayHop || typeof gatewayHop !== "object" || kHiddenStates.has(state)) {
    return { visible: false, state, tone: "unknown", label: "", detail: "" };
  }
  const checkedAgeMs = resolveCheckedAgeMs(gatewayHop, nowMs);
  const staleAfterMs = Number(gatewayHop.staleAfterMs);
  const staleNow =
    state === "stale" ||
    (Number.isFinite(staleAfterMs) &&
      staleAfterMs > 0 &&
      checkedAgeMs != null &&
      checkedAgeMs > staleAfterMs);
  const checkedLabel = formatRelativeAge(checkedAgeMs);
  const failures = Math.max(0, Number(gatewayHop.consecutiveFailures) || 0);
  const threshold = Math.max(1, Number(gatewayHop.alarmFailureThreshold) || 2);

  if (state === "invalid") {
    return {
      visible: true,
      state,
      tone: "unknown",
      label: "probe data invalid",
      detail: gatewayHop.reason ? String(gatewayHop.reason) : "",
    };
  }
  if (staleNow) {
    return {
      visible: true,
      state: "stale",
      tone: "unknown",
      label: "unknown",
      detail: `last probe ${checkedLabel}`,
    };
  }
  if (state === "failing") {
    const parts = [
      gatewayHop.error ? String(gatewayHop.error) : "probe failed",
      pluralize(failures, "consecutive failure"),
      `checked ${checkedLabel}`,
    ];
    return {
      visible: true,
      state,
      tone: failures >= threshold ? "danger" : "warning",
      label: "unreachable",
      detail: parts.join(" · "),
    };
  }
  if (state === "healthy") {
    return {
      visible: true,
      state,
      tone: "healthy",
      label: "reachable",
      detail: `checked ${checkedLabel}`,
    };
  }
  return {
    visible: true,
    state,
    tone: "unknown",
    label: state.replace(/_/g, " "),
    detail: "",
  };
};
