const {
  createTelegramOwnerCapture,
  kCaptureTtlMs,
} = require("../../lib/server/telegram-owner-capture");

const kToken = "123456789:AA-secret-token-value";
const kNonce = "nonce_abc-123";

const createApiMock = ({ updates = [], getUpdatesError = null } = {}) => {
  const api = {
    getMe: vi.fn(async () => ({ id: 123456789, is_bot: true, username: "alpha_wolf_bot" })),
    getUpdates: vi.fn(async ({ offset } = {}) => {
      if (getUpdatesError) throw getUpdatesError;
      return offset == null ? updates : [];
    }),
    sendMessage: vi.fn(async () => ({})),
  };
  return { api, createApi: vi.fn(() => api) };
};

const startMessage = (updateId, text, from = {}) => ({
  update_id: updateId,
  message: {
    chat: { id: from.id || 42, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Bill", username: "billk", ...from },
    text,
  },
});

describe("server/telegram-owner-capture", () => {
  it("hands out a one-time t.me start link for the bot", async () => {
    const capture = createTelegramOwnerCapture({ createNonce: () => kNonce });
    const { createApi } = createApiMock();

    await expect(capture.start({ token: kToken, createApi })).resolves.toEqual({
      nonce: kNonce,
      link: `https://t.me/alpha_wolf_bot?start=${kNonce}`,
      expiresInMs: kCaptureTtlMs,
    });
    expect(createApi).toHaveBeenCalledWith(kToken);
  });

  it("captures whoever sent /start with the nonce and marks the queue read", async () => {
    const capture = createTelegramOwnerCapture({ createNonce: () => kNonce });
    const { api, createApi } = createApiMock({
      updates: [
        startMessage(10, "hello", { id: 7, username: "someone" }),
        startMessage(11, `/start ${kNonce}`, { last_name: "K" }),
        startMessage(12, "after"),
      ],
    });
    await capture.start({ token: kToken, createApi });

    await expect(
      capture.poll({ token: kToken, nonce: kNonce, createApi }),
    ).resolves.toEqual({
      owner: { id: "42", username: "billk", name: "Bill K" },
    });
    expect(api.getUpdates).toHaveBeenNthCalledWith(1, {
      timeout: 8,
      allowedUpdates: ["message"],
    });
    // Acknowledged through the /start so OpenClaw never replays it.
    expect(api.getUpdates).toHaveBeenNthCalledWith(2, { offset: 12, timeout: 0 });
    expect(api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("Clawbridge"));

    // The link is single use.
    await expect(
      capture.poll({ token: kToken, nonce: kNonce, createApi }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  it("ignores group messages, bots, and other start payloads", async () => {
    const capture = createTelegramOwnerCapture({ createNonce: () => kNonce });
    const groupStart = startMessage(20, `/start ${kNonce}`);
    groupStart.message.chat.type = "group";
    const { api, createApi } = createApiMock({
      updates: [
        groupStart,
        startMessage(21, `/start ${kNonce}`, { is_bot: true }),
        startMessage(22, "/start other"),
      ],
    });
    await capture.start({ token: kToken, createApi });

    await expect(
      capture.poll({ token: kToken, nonce: kNonce, createApi }),
    ).resolves.toEqual({ owner: null });
    expect(api.getUpdates).toHaveBeenLastCalledWith({ offset: 23, timeout: 0 });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("expires links after ten minutes", async () => {
    let now = 1_000_000;
    const capture = createTelegramOwnerCapture({
      now: () => now,
      createNonce: () => kNonce,
    });
    const { api, createApi } = createApiMock();
    await capture.start({ token: kToken, createApi });
    now += kCaptureTtlMs + 1;

    await expect(
      capture.poll({ token: kToken, nonce: kNonce, createApi }),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it("explains when another poller or webhook already owns the bot", async () => {
    const conflict = new Error("Conflict: terminated by other getUpdates request");
    conflict.telegramErrorCode = 409;
    const capture = createTelegramOwnerCapture({ createNonce: () => kNonce });
    const { createApi } = createApiMock({ getUpdatesError: conflict });
    await capture.start({ token: kToken, createApi });

    await expect(
      capture.poll({ token: kToken, nonce: kNonce, createApi }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already connected somewhere else"),
    });
  });
});
