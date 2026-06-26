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
      "openai-codex": true,
    });
    expect(
      modelPicker.buildProviderHasAuth({
        authProfiles: [],
        codexStatus: { connected: true },
        openAiAuthMode: "api_key",
      }).openai,
    ).toBeUndefined();
  });
});
