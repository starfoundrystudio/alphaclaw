const { createGmailServeEnv } = require("../../lib/server/gmail-serve");

describe("server/gmail-serve", () => {
  it("asks the managed gog launcher to rotate before the static lease expires", () => {
    expect(
      createGmailServeEnv(
        {
          OPENCLAW_DIR: "/managed/openclaw",
          GOG_KEYRING_PASSWORD: "password",
        },
        { PATH: "/usr/bin" },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/managed/openclaw",
      GOG_KEYRING_PASSWORD: "password",
      ALPHACLAW_GOG_RESTART_BEFORE_EXPIRY_SECONDS: "600",
    });
  });
});
