import {
  isTelegramBotTokenShape,
  kTelegramBotFatherUrl,
} from "../../lib/public/js/components/agents-tab/create-channel-modal/telegram-setup.js";

describe("frontend/telegram-channel-setup", () => {
  it("links only to the official BotFather account", () => {
    expect(kTelegramBotFatherUrl).toBe("https://t.me/BotFather");
  });

  it("accepts complete BotFather tokens and rejects partial input", () => {
    expect(
      isTelegramBotTokenShape(
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      ),
    ).toBe(true);
    expect(isTelegramBotTokenShape("123456789:")).toBe(false);
    expect(isTelegramBotTokenShape("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
      false,
    );
  });
});
