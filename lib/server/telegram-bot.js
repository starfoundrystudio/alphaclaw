const { createTelegramApi } = require("./telegram-api");

const kTelegramBotTokenPattern = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;

const normalizeTelegramBotToken = (value) => String(value || "").trim();

const isTelegramBotTokenShape = (value) =>
  kTelegramBotTokenPattern.test(normalizeTelegramBotToken(value));

const inspectTelegramBotToken = async (
  token,
  { createApi = createTelegramApi } = {},
) => {
  const normalizedToken = normalizeTelegramBotToken(token);
  if (!isTelegramBotTokenShape(normalizedToken)) {
    const error = new Error(
      "Enter the bot token from @BotFather. It should look like 123456789:AA...",
    );
    error.statusCode = 400;
    throw error;
  }

  try {
    const bot = await createApi(normalizedToken).getMe();
    if (!bot?.is_bot) {
      const error = new Error("That token does not belong to a Telegram bot.");
      error.statusCode = 400;
      throw error;
    }
    const username = String(bot.username || "").trim();
    const name = [bot.first_name, bot.last_name]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    return {
      id: String(bot.id || "").trim(),
      name: name || username || "Telegram Bot",
      username,
      link: username ? `https://t.me/${username}` : "",
    };
  } catch (error) {
    if (error?.statusCode) throw error;
    const rejected = Number(error?.telegramErrorCode || 0) === 401;
    const nextError = new Error(
      rejected
        ? "Telegram rejected this bot token. Copy a fresh token from @BotFather and try again."
        : "Could not verify this bot with Telegram. Check the token and try again.",
    );
    nextError.statusCode = rejected ? 400 : 502;
    throw nextError;
  }
};

module.exports = {
  inspectTelegramBotToken,
  isTelegramBotTokenShape,
};
