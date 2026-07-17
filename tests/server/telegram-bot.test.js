const {
  inspectTelegramBotToken,
  isTelegramBotTokenShape,
} = require("../../lib/server/telegram-bot");

describe("server/telegram-bot", () => {
  it("recognizes the token shape issued by BotFather", () => {
    expect(
      isTelegramBotTokenShape(
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      ),
    ).toBe(true);
    expect(isTelegramBotTokenShape("not-a-token")).toBe(false);
  });

  it("returns safe bot identity details from Telegram getMe", async () => {
    const getMe = vi.fn(async () => ({
      id: 123456789,
      is_bot: true,
      first_name: "Alpha",
      last_name: "Wolf",
      username: "alpha_wolf_bot",
    }));
    const createApi = vi.fn(() => ({ getMe }));

    await expect(
      inspectTelegramBotToken(
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
        { createApi },
      ),
    ).resolves.toEqual({
      id: "123456789",
      name: "Alpha Wolf",
      username: "alpha_wolf_bot",
      link: "https://t.me/alpha_wolf_bot",
    });
  });

  it("turns Telegram authentication failures into actionable copy", async () => {
    const telegramError = new Error("Unauthorized");
    telegramError.telegramErrorCode = 401;

    await expect(
      inspectTelegramBotToken(
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
        {
          createApi: () => ({
            getMe: vi.fn(async () => {
              throw telegramError;
            }),
          }),
        },
      ),
    ).rejects.toThrow("Telegram rejected this bot token");
  });
});
