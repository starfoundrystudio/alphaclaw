export const getGoogleDisconnectOutcome = (result = {}) => {
  if (result.ok) {
    return {
      refresh: true,
      tone: "success",
      message: "Google account disconnected",
    };
  }
  if (result.localDisconnected && result.revocationPending) {
    return {
      refresh: true,
      tone: "warning",
      message:
        "Google account disconnected locally; gateway revocation will retry automatically",
    };
  }
  return {
    refresh: false,
    tone: "error",
    message: `Failed to disconnect: ${result.error || "unknown"}`,
  };
};
