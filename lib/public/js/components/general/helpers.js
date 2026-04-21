export const shouldPrimePairingsFetch = ({
  isActive = false,
  hasUnpaired = false,
  gatewayStatus = "",
} = {}) => Boolean(isActive && hasUnpaired && gatewayStatus === "running");

export const shouldEnableRecurringPairingsPolling = ({
  hasUnpaired = false,
  gatewayStatus = "",
  pairingsPollingEnabled = false,
} = {}) => Boolean(hasUnpaired && gatewayStatus === "running" && pairingsPollingEnabled);

export const derivePairingsPollingEnabled = (pending = []) =>
  Array.isArray(pending) && pending.length > 0;
