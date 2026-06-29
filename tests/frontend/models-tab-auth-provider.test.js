const loadModelPicker = async () =>
  import("../../lib/public/js/components/models-tab/model-picker.js");
const loadModelsTab = async () =>
  import("../../lib/public/js/components/models-tab/index.js");

describe("frontend/models-tab auth provider mapping", () => {
  it("maps legacy openai-codex model refs to the OpenAI auth card", async () => {
    const modelPicker = await loadModelPicker();

    expect(modelPicker.getModelsTabAuthProvider("openai/gpt-5.5")).toBe(
      "openai",
    );
    expect(modelPicker.getModelsTabAuthProvider("openai-codex/gpt-5.5")).toBe(
      "openai",
    );
  });

  it("derives OpenAI auth mode from configured runtime", async () => {
    const modelsTab = await loadModelsTab();

    expect(
      modelsTab.getOpenAiAuthMode({
        configuredModels: { "openai/gpt-5.5": {} },
        providerRuntimeIds: { openai: "codex" },
      }),
    ).toBe("codex");
    expect(
      modelsTab.getOpenAiAuthMode({
        configuredModels: { "openai/gpt-5.5": {} },
        providerRuntimeIds: {},
      }),
    ).toBe("api_key");
  });

  it("derives Anthropic auth mode from configured Claude CLI runtime", async () => {
    const modelsTab = await loadModelsTab();

    expect(
      modelsTab.getAnthropicAuthMode({
        configuredModels: { "anthropic/claude-opus-4-8": {} },
        modelRuntimeIds: { "anthropic/claude-opus-4-8": "claude-cli" },
      }),
    ).toBe("claude-cli");
    expect(
      modelsTab.getAnthropicAuthMode({
        configuredModels: { "anthropic/claude-opus-4-8": {} },
        providerRuntimeIds: {},
      }),
    ).toBe("api_key");
  });

  it("treats connected Codex OAuth as OpenAI auth only for Codex runtime", async () => {
    const modelPicker = await loadModelPicker();

    expect(
      modelPicker.buildProviderHasAuth({
        authProfiles: [],
        codexStatus: { connected: true },
        openAiAuthMode: "codex",
      }),
    ).toMatchObject({
      openai: true,
    });
    expect(
      modelPicker.buildProviderHasAuth({
        authProfiles: [],
        codexStatus: { connected: true },
        openAiAuthMode: "api_key",
      }).openai,
    ).toBeUndefined();
  });

  it("treats connected Claude CLI as Anthropic auth only for Claude CLI runtime", async () => {
    const modelPicker = await loadModelPicker();

    expect(
      modelPicker.buildProviderHasAuth({
        authProfiles: [
          { id: "anthropic:claude-cli", provider: "claude-cli", type: "oauth" },
        ],
        anthropicAuthMode: "claude-cli",
        claudeCliStatus: {
          ok: true,
          installed: true,
          loggedIn: true,
          configured: true,
        },
      }),
    ).toMatchObject({
      anthropic: true,
    });
    expect(
      modelPicker.buildProviderHasAuth({
        authProfiles: [
          { id: "anthropic:claude-cli", provider: "claude-cli", type: "oauth" },
        ],
        anthropicAuthMode: "api_key",
        claudeCliStatus: {
          ok: true,
          installed: true,
          loggedIn: true,
          configured: true,
        },
      }).anthropic,
    ).toBeUndefined();
  });
});
