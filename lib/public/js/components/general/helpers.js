export const shouldPrimePairingsFetch = ({
  isActive = false,
  hasUnpaired = false,
  gatewayStatus = "",
} = {}) => Boolean(isActive && hasUnpaired && gatewayStatus === "running");

// Poll for pairing requests the whole time an unpaired channel is waiting
// for its first DM — that is exactly when new requests arrive out of thin
// air. (A previous gate only kept polling while requests already existed,
// so the request created by the user's first DM never appeared without a
// manual page refresh.)
export const shouldEnableRecurringPairingsPolling = ({
  isActive = false,
  hasUnpaired = false,
  gatewayStatus = "",
} = {}) => Boolean(isActive && hasUnpaired && gatewayStatus === "running");
