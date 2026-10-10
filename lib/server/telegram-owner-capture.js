const crypto = require("crypto");
const { createTelegramApi } = require("./telegram-api");

// Learns the owner's Telegram user id before the channel is connected: the
// owner opens t.me/<bot>?start=<nonce> and taps Start, and the bot's own
// update queue tells us who sent `/start <nonce>`. This runs before OpenClaw
// polls the bot, so the two never compete for getUpdates.
const kCaptureTtlMs = 10 * 60 * 1000;
const kMaxPendingCaptures = 50;
const kPollTimeoutSeconds = 8;
const kConfirmationText =
  "Got it! Head back to Clawbridge to finish connecting this bot.";

const createCaptureError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const toTelegramApiError = (error) => {
  if (error?.statusCode) return error;
  const code = Number(error?.telegramErrorCode || 0);
  if (code === 409) {
    return createCaptureError(
      "This bot is already connected somewhere else (another app or a webhook). Disconnect it there, or skip this step and pair by DM.",
      409,
    );
  }
  if (code === 401) {
    return createCaptureError(
      "Telegram rejected this bot token. Copy a fresh token from @BotFather and try again.",
    );
  }
  return createCaptureError("Could not reach Telegram. Try again.", 502);
};

const isStartCommandFor = (update, nonce) => {
  const message = update?.message;
  return (
    message?.chat?.type === "private" &&
    !!message?.from &&
    !message.from.is_bot &&
    String(message.text || "").trim() === `/start ${nonce}`
  );
};

const createTelegramOwnerCapture = ({
  now = () => Date.now(),
  createNonce = () => crypto.randomBytes(18).toString("base64url"),
} = {}) => {
  const captures = new Map();

  const prune = () => {
    const cutoff = now() - kCaptureTtlMs;
    for (const [nonce, capture] of captures) {
      if (capture.createdAt < cutoff) captures.delete(nonce);
    }
    while (captures.size >= kMaxPendingCaptures) {
      captures.delete(captures.keys().next().value);
    }
  };

  const start = async ({ token, createApi = createTelegramApi } = {}) => {
    let bot;
    try {
      bot = await createApi(String(token || "").trim()).getMe();
    } catch (error) {
      throw toTelegramApiError(error);
    }
    const username = String(bot?.username || "").trim();
    if (!username) {
      throw createCaptureError("Telegram did not return this bot's username.", 502);
    }
    prune();
    const nonce = createNonce();
    captures.set(nonce, { createdAt: now() });
    return {
      nonce,
      link: `https://t.me/${username}?start=${nonce}`,
      expiresInMs: kCaptureTtlMs,
    };
  };

  const poll = async ({ token, nonce, createApi = createTelegramApi } = {}) => {
    const normalizedNonce = String(nonce || "").trim();
    const capture = captures.get(normalizedNonce);
    if (!capture || capture.createdAt < now() - kCaptureTtlMs) {
      captures.delete(normalizedNonce);
      throw createCaptureError(
        "This confirmation link expired. Start again.",
        410,
      );
    }
    const api = createApi(String(token || "").trim());
    let updates;
    try {
      updates = await api.getUpdates({
        timeout: kPollTimeoutSeconds,
        allowedUpdates: ["message"],
      });
    } catch (error) {
      throw toTelegramApiError(error);
    }
    const list = Array.isArray(updates) ? updates : [];
    const match = list.find((update) => isStartCommandFor(update, normalizedNonce));
    // Mark everything read up to here (through the match, or the whole batch
    // when there is none): these messages predate the connection, and the
    // `/start` must not reach the agent once OpenClaw starts polling.
    const lastUpdate = match || list[list.length - 1];
    if (lastUpdate && Number.isFinite(Number(lastUpdate.update_id))) {
      await api
        .getUpdates({ offset: Number(lastUpdate.update_id) + 1, timeout: 0 })
        .catch(() => {});
    }
    if (!match) return { owner: null };

    captures.delete(normalizedNonce);
    const from = match.message.from;
    await api
      .sendMessage(match.message.chat.id, kConfirmationText)
      .catch(() => {});
    const name = [from.first_name, from.last_name]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    const username = String(from.username || "").trim();
    return {
      owner: {
        id: String(from.id),
        username,
        name: name || (username ? `@${username}` : "Telegram user"),
      },
    };
  };

  return { start, poll };
};

module.exports = { createTelegramOwnerCapture, kCaptureTtlMs };
