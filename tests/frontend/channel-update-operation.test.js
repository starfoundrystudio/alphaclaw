const loadChannelUpdateOperationModule = async () =>
  import("../../lib/public/js/lib/channel-update-operation.js");

const mockApi = ({
  accountResult = { ok: true, restartRequired: false },
  policyResult = { ok: true, restartRequired: false },
  accountError = null,
} = {}) => {
  const updateChannelAccount = vi.fn(async () => {
    if (accountError) throw accountError;
    return accountResult;
  });
  const updateChannelAccountPolicy = vi.fn(async () => policyResult);
  const invalidateCache = vi.fn();
  vi.doMock("../../lib/public/js/lib/api.js", () => ({
    updateChannelAccount,
    updateChannelAccountPolicy,
  }));
  vi.doMock("../../lib/public/js/lib/api-cache.js", () => ({
    invalidateCache,
  }));
  return { updateChannelAccount, updateChannelAccountPolicy, invalidateCache };
};

const kEditPayload = {
  provider: "telegram",
  name: "Alerts",
  accountId: "alerts",
  agentId: "ops",
};

describe("frontend/channel-update-operation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("persists policy through the policy endpoint after the account update", async () => {
    const policy = { dmPolicy: "allowlist", allowFrom: ["123"] };
    const api = mockApi({
      accountResult: { ok: true, restartRequired: false, tokenUpdated: false },
      policyResult: { ok: true, restartRequired: false, policy: { dmPolicy: "allowlist" } },
    });
    const { saveChannelAccountEdit, kChannelAccountsCacheKey } =
      await loadChannelUpdateOperationModule();

    const result = await saveChannelAccountEdit({ ...kEditPayload, policy });

    expect(api.updateChannelAccount).toHaveBeenCalledWith(kEditPayload);
    expect(api.updateChannelAccountPolicy).toHaveBeenCalledWith({
      provider: "telegram",
      accountId: "alerts",
      policy,
    });
    expect(
      api.updateChannelAccount.mock.invocationCallOrder[0],
    ).toBeLessThan(api.updateChannelAccountPolicy.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      ok: true,
      tokenUpdated: false,
      restartRequired: false,
      policy: { dmPolicy: "allowlist" },
    });
    expect(api.invalidateCache).toHaveBeenCalledWith(kChannelAccountsCacheKey);
    expect(kChannelAccountsCacheKey).toBe("/api/channels/accounts");
  });

  it("skips the policy endpoint when the payload has no policy (WhatsApp)", async () => {
    const api = mockApi();
    const { saveChannelAccountEdit } = await loadChannelUpdateOperationModule();

    await saveChannelAccountEdit({ ...kEditPayload, provider: "whatsapp" });

    expect(api.updateChannelAccount).toHaveBeenCalledTimes(1);
    expect(api.updateChannelAccountPolicy).not.toHaveBeenCalled();
    expect(api.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("reports restartRequired when either call requires a restart", async () => {
    const fromAccount = mockApi({
      accountResult: { ok: true, restartRequired: true },
    });
    let mod = await loadChannelUpdateOperationModule();
    expect(
      (await mod.saveChannelAccountEdit({ ...kEditPayload, policy: {} }))
        .restartRequired,
    ).toBe(true);
    expect(fromAccount.updateChannelAccountPolicy).toHaveBeenCalled();

    vi.resetModules();
    mockApi({ policyResult: { ok: true, restartRequired: true } });
    mod = await loadChannelUpdateOperationModule();
    expect(
      (await mod.saveChannelAccountEdit({ ...kEditPayload, policy: {} }))
        .restartRequired,
    ).toBe(true);
  });

  it("does not save policy when the account update fails, but still invalidates the cache", async () => {
    const api = mockApi({ accountError: new Error("Agent \"ops\" not found") });
    const { saveChannelAccountEdit } = await loadChannelUpdateOperationModule();

    await expect(
      saveChannelAccountEdit({ ...kEditPayload, policy: { dmPolicy: "open" } }),
    ).rejects.toThrow('Agent "ops" not found');
    expect(api.updateChannelAccountPolicy).not.toHaveBeenCalled();
    expect(api.invalidateCache).toHaveBeenCalledTimes(1);
  });
});
