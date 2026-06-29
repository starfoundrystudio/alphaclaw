const loadModelPicker = async () =>
  import("../../lib/public/js/components/models-tab/model-picker.js");
const loadModelsTab = async () =>
  import("../../lib/public/js/components/models-tab/index.js");
const loadAddModelModal = async () =>
  import("../../lib/public/js/components/models-tab/add-model-modal.js");

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

  it("builds separate auth routes for mixed Anthropic runtimes", async () => {
    const modelsTab = await loadModelsTab();

    expect(
      modelsTab
        .buildRequiredAuthRoutes({
          configuredModels: {
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-8": {},
          },
          modelRuntimeIds: {
            "anthropic/claude-sonnet-4-6": "claude-cli",
          },
        })
        .map((route) => route.id),
    ).toEqual(["anthropic:claude-cli", "anthropic:api_key"]);
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

  it("builds configured model entries for Add Model access routes", async () => {
    const addModelModal = await loadAddModelModal();
    const catalog = [
      { key: "openai/gpt-5.5", provider: "openai", label: "GPT-5.5" },
      {
        key: "claude-cli/claude-opus-4-8",
        provider: "claude-cli",
        label: "Claude Opus 4.8",
      },
      {
        key: "anthropic/claude-opus-4-8",
        provider: "anthropic",
        label: "Claude Opus 4.8",
      },
    ];

    expect(
      addModelModal.buildAddModelSelection({
        modelKey: "openai/gpt-5.5",
        accessMode: "subscription",
        provider: "openai",
        catalog,
      }),
    ).toEqual({
      modelKey: "openai/gpt-5.5",
      modelConfig: { agentRuntime: { id: "codex" } },
    });
    expect(
      addModelModal.buildAddModelSelection({
        modelKey: "claude-cli/claude-opus-4-8",
        accessMode: "subscription",
        provider: "claude-cli",
        catalog,
      }),
    ).toEqual({
      modelKey: "anthropic/claude-opus-4-8",
      modelConfig: { agentRuntime: { id: "claude-cli" } },
    });
    expect(
      addModelModal.buildAddModelSelection({
        modelKey: "anthropic/claude-opus-4-8",
        accessMode: "provider-api",
        provider: "anthropic",
        catalog,
      }),
    ).toEqual({
      modelKey: "anthropic/claude-opus-4-8",
      modelConfig: {},
    });
  });
});
