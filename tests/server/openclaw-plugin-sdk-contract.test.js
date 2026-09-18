const {
  assertSupportedOpenclawPluginSdk,
  kRequiredPluginSdkExports,
} = require("../../lib/server/openclaw-plugin-sdk-contract");

describe("server/openclaw-plugin-sdk-contract", () => {
  it("imports every supported OpenClaw plugin SDK subpath used at runtime", async () => {
    await expect(assertSupportedOpenclawPluginSdk()).resolves.toEqual(
      Object.keys(kRequiredPluginSdkExports).map(
        (subpath) => `openclaw/plugin-sdk/${subpath}`,
      ),
    );
  });
});
