import { updateChannelAccount, updateChannelAccountPolicy } from "./api.js";
import { invalidateCache } from "./api-cache.js";

export const kChannelAccountsCacheKey = "/api/channels/accounts";

// Saves a channel account edit (the channel modal, or an Agents tab quick
// bind). The account endpoint only persists name/agent/token, so access
// policy goes through its own endpoint. Every entry point (General tab,
// Agents tab) must save through here so a policy edit is never silently
// dropped and the shared channel accounts cache never goes stale.
export const saveChannelAccountEdit = async (payload = {}) => {
  const { policy, ...accountPayload } = payload || {};
  try {
    const accountResult = await updateChannelAccount(accountPayload);
    const policyResult = policy
      ? await updateChannelAccountPolicy({
          provider: accountPayload.provider,
          accountId: accountPayload.accountId,
          policy,
        })
      : null;
    return {
      ...accountResult,
      ...(policyResult ? { policy: policyResult.policy } : {}),
      restartRequired:
        !!accountResult?.restartRequired || !!policyResult?.restartRequired,
    };
  } finally {
    // Even a partial failure may have written the account half.
    invalidateCache(kChannelAccountsCacheKey);
  }
};
