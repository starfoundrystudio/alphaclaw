const fs = require("fs");

const { kOnboardingMarkerPath } = require("../../lib/server/constants");

const kRuntimeStorePath = require.resolve("../../lib/server/agent-vault/runtime-store");
const kGatewayPath = require.resolve("../../lib/server/gateway");
const kProxy = "http://av_token:default@127.0.0.1:14323/";

const loadGateway = () => {
  delete require.cache[kGatewayPath];
  delete require.cache[kRuntimeStorePath];
  const runtimeStore = require(kRuntimeStorePath);
  vi.spyOn(runtimeStore, "buildAgentVaultRuntimeEnv").mockReturnValue({
    HTTPS_PROXY: kProxy,
    HTTP_PROXY: kProxy,
    AGENT_VAULT_TOKEN: "av_token",
  });
  return require(kGatewayPath);
};

describe("server/gateway Agent Vault runtime env", () => {
  const originalExistsSync = fs.existsSync;

  afterEach(() => {
    fs.existsSync = originalExistsSync;
    delete require.cache[kGatewayPath];
    delete require.cache[kRuntimeStorePath];
  });

  // A Cloudflare Tunnel gateway is sealed at install, so the vault runtime is
  // claimed before the owner runs setup. Setup commands must still run
  // without the vault proxy, as they always have on Tailscale instances.
  it("leaves the vault proxy out of OpenClaw commands until onboarding completes", () => {
    fs.existsSync = vi.fn(() => false);
    const gateway = loadGateway();

    expect(gateway.gatewayEnv().HTTPS_PROXY).toBeUndefined();
    expect(gateway.gatewayMaintenanceEnv().HTTPS_PROXY).toBeUndefined();
    expect(gateway.gatewayEnv().AGENT_VAULT_TOKEN).toBeUndefined();
  });

  it("routes OpenClaw through the vault proxy once onboarded", () => {
    fs.existsSync = vi.fn((target) => target === kOnboardingMarkerPath);
    const gateway = loadGateway();

    expect(gateway.gatewayEnv().HTTPS_PROXY).toBe(kProxy);
    expect(gateway.gatewayMaintenanceEnv().HTTPS_PROXY).toBe(kProxy);
    expect(gateway.gatewayEnv().AGENT_VAULT_TOKEN).toBe("av_token");
  });
});
