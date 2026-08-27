const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  createModelCatalogCache,
  kModelCatalogBootstrapSource,
  kModelCatalogLoadTimeoutMs,
} = require("../../lib/server/model-catalog-cache");
const { registerModelRoutes } = require("../../lib/server/routes/models");
const { kFallbackOnboardingModels } = require("../../lib/server/constants");

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const expectModelAccessModes = () =>
  expect.objectContaining({
    subscription: expect.objectContaining({
      providers: expect.any(Array),
    }),
    "provider-api": expect.objectContaining({
      providers: expect.any(Array),
    }),
    gateway: expect.objectContaining({
      providers: expect.any(Array),
    }),
  });

const createModelDeps = () => {
  const deps = {
    shellCmd: vi.fn(),
    gatewayEnv: vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" })),
    parseJsonFromNoisyOutput: vi.fn(() => ({})),
    normalizeOnboardingModels: vi.fn(() => []),
    readOpenclawVersion: vi.fn(() => "2026.4.15"),
    isOnboarded: vi.fn(() => true),
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(() => true),
    reconcileOpenclawPlugins: vi.fn(async () => ({ plugins: [] })),
    agentVaultService: null,
    hasVaultRuntime: vi.fn(() => false),
    rootDir: "/tmp/alphaclaw",
    openclawDir: "/tmp/openclaw",
    fsModule: fs,
    authProfiles: {
      getModelConfig: vi.fn(() => ({ primary: null, configuredModels: {} })),
      listProfiles: vi.fn(() => []),
      loadAuthStore: vi.fn(() => ({ profiles: {}, order: {} })),
      getProfile: vi.fn(() => null),
      setModelConfig: vi.fn(),
      upsertProfile: vi.fn(),
      getEnvVarForApiKeyProvider: vi.fn((provider) =>
        provider === "openai" ? "OPENAI_API_KEY" : "",
      ),
      listApiKeyProviders: vi.fn(() => ["openai"]),
      getDefaultProfileIdForApiKeyProvider: vi.fn((provider) =>
        provider ? `${provider}:default` : "",
      ),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      removeApiKeyProfileForEnvVar: vi.fn(),
      setAuthOrder: vi.fn(),
      syncConfigAuthReferencesForAgent: vi.fn(),
      removeProfile: vi.fn(),
    },
  };
  return deps;
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "alphaclaw-routes-models-"),
  );
  const modelCatalogCache = createModelCatalogCache({
    cachePath: path.join(tempRoot, "cache", "model-catalog.json"),
    shellCmd: deps.shellCmd,
    gatewayEnv: deps.gatewayEnv,
    parseJsonFromNoisyOutput: deps.parseJsonFromNoisyOutput,
    normalizeOnboardingModels: deps.normalizeOnboardingModels,
    readOpenclawVersion: deps.readOpenclawVersion,
    shouldStartDynamicRefresh: deps.isOnboarded,
  });
  registerModelRoutes({
    app,
    ...deps,
    modelCatalogCache,
  });
  return app;
};

describe("server/routes/models", () => {
  it("bootstraps with the bundled catalog, then returns normalized models from openclaw output", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("noise");
    deps.parseJsonFromNoisyOutput.mockReturnValue({
      models: [{ key: "openai/gpt-5.1-codex", name: "GPT" }],
    });
    deps.normalizeOnboardingModels.mockReturnValue([
      { key: "openai/gpt-5.1-codex", provider: "openai", label: "GPT" },
    ]);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
      accessModes: expectModelAccessModes(),
    });
    expect(deps.shellCmd).toHaveBeenCalledWith(
      "openclaw models list --all --json",
      {
        env: { OPENCLAW_GATEWAY_TOKEN: "token" },
        timeout: kModelCatalogLoadTimeoutMs,
      },
    );

    await flushPromises();

    const refreshed = await request(app).get("/api/models");

    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toEqual(
      expect.objectContaining({
        ok: true,
        source: "openclaw",
        stale: false,
        refreshing: false,
        fetchedAt: expect.any(Number),
        models: [
          { key: "openai/gpt-5.1-codex", provider: "openai", label: "GPT" },
        ],
      }),
    );
  });

  it("serves the bundled catalog while a dynamic refresh resolves empty", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("{}");
    deps.parseJsonFromNoisyOutput.mockReturnValue({ models: [] });
    deps.normalizeOnboardingModels.mockReturnValue([]);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
      accessModes: expectModelAccessModes(),
    });
  });

  it("serves the bundled catalog when the dynamic refresh command throws", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockRejectedValue(new Error("boom"));
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
      accessModes: expectModelAccessModes(),
    });
  });

  it("serves the bundled catalog without launching openclaw before onboarding", async () => {
    const deps = createModelDeps();
    deps.isOnboarded.mockReturnValue(false);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: false,
      models: kFallbackOnboardingModels,
      accessModes: expectModelAccessModes(),
    });
    expect(
      res.body.models.some(
        (model) => model.key === "openrouter/anthropic/claude-sonnet-4.6",
      ),
    ).toBe(true);
    expect(
      res.body.models.some(
        (model) =>
          model.key === "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
      ),
    ).toBe(true);
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("returns thinking options for a model key on GET /api/models/thinking-options", async () => {
    const deps = createModelDeps();
    const app = createApp(deps);

    const res = await request(app).get(
      "/api/models/thinking-options?modelKey=anthropic/claude-opus-4-7",
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.modelKey).toBe("anthropic/claude-opus-4-7");
    expect(Array.isArray(res.body.levels)).toBe(true);
    expect(res.body.levels.length).toBeGreaterThan(1);
    expect(res.body.levels.some((entry) => entry.id === "off")).toBe(true);
    expect(typeof res.body.modelDefault).toBe("string");
    expect(typeof res.body.inheritedDefault).toBe("string");
  });

  it("returns model status payload on GET /api/models/status", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("{}");
    deps.parseJsonFromNoisyOutput.mockReturnValue({
      resolvedDefault: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/models/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      modelKey: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
  });

  it("recovers model status payload from failed command output", async () => {
    const deps = createModelDeps();
    const err = new Error("plugin load failed");
    err.stdout =
      'prefix\n{"resolvedDefault":"openai/gpt-5.1-codex","fallbacks":["anthropic/claude-opus-4-6"],"imageModel":"google/gemini-3.1-pro-preview"}\n';
    err.stderr =
      "[plugins] google failed to load from /srv/alphaclaw/node_modules/openclaw/dist/extensions/google/index.js";
    deps.shellCmd.mockRejectedValue(err);
    deps.parseJsonFromNoisyOutput.mockImplementation((raw) =>
      String(raw).includes("resolvedDefault")
        ? {
            resolvedDefault: "openai/gpt-5.1-codex",
            fallbacks: ["anthropic/claude-opus-4-6"],
            imageModel: "google/gemini-3.1-pro-preview",
          }
        : null,
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/models/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      modelKey: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
  });

  it("validates modelKey on POST /api/models/set", async () => {
    const deps = createModelDeps();
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Missing modelKey" });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("sets model when modelKey is valid", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "openai/gpt-5.1-codex" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.shellCmd).toHaveBeenCalledWith(
      'openclaw models set "openai/gpt-5.1-codex"',
      {
        env: { OPENCLAW_GATEWAY_TOKEN: "token" },
        timeout: 30000,
      },
    );
  });

  it("rejects Vercel AI Gateway model sets with an invalid env-backed key", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([
      { key: "AI_GATEWAY_API_KEY", value: "not-a-vercel-key" },
    ]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) =>
        provider === "vercel-ai-gateway" ? "AI_GATEWAY_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "vercel-ai-gateway/openai/gpt-5.5" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "AI_GATEWAY_API_KEY must start with vck_",
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("returns JSON when model-set credential validation reads fail", async () => {
    const deps = createModelDeps();
    deps.readEnvFile.mockImplementation(() => {
      throw new Error("env unreadable");
    });
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "vercel-ai-gateway/openai/gpt-5.5" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "env unreadable" });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("re-syncs auth references on PUT /api/models/config", async () => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousGithubRepo = process.env.GITHUB_WORKSPACE_REPO;
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_WORKSPACE_REPO = "owner/repo";
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    const app = createApp(deps);

    try {
      const res = await request(app)
        .put("/api/models/config")
        .send({
          primary: "openai-codex/gpt-5.3-codex",
          configuredModels: {
            "openai-codex/gpt-5.3-codex": {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(deps.authProfiles.setModelConfig).toHaveBeenCalledWith({
        primary: "openai-codex/gpt-5.3-codex",
        configuredModels: {
          "openai-codex/gpt-5.3-codex": {},
        },
      });
      expect(
        deps.authProfiles.syncConfigAuthReferencesForAgent,
      ).toHaveBeenCalledWith(undefined);
      expect(deps.shellCmd).toHaveBeenCalledWith(
        'alphaclaw git-sync -m "models: update config" -f "openclaw.json"',
        { timeout: 30000 },
      );
    } finally {
      if (previousGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGithubToken;
      }
      if (previousGithubRepo === undefined) {
        delete process.env.GITHUB_WORKSPACE_REPO;
      } else {
        process.env.GITHUB_WORKSPACE_REPO = previousGithubRepo;
      }
    }
  });

  it("reconciles managed agent runtime plugins on PUT /api/models/config", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.authProfiles.setModelConfig.mockReturnValue({
      managedPluginIds: ["codex"],
    });
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "openai/gpt-5.5",
        configuredModels: {
          "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.reconcileOpenclawPlugins).toHaveBeenCalledWith({
      rootDir: "/tmp/alphaclaw",
      openclawDir: "/tmp/openclaw",
      fsModule: fs,
      logger: console,
      env: process.env,
    });
  });

  it("returns a helpful error when managed runtime plugin reconciliation fails", async () => {
    const deps = createModelDeps();
    deps.authProfiles.setModelConfig.mockReturnValue({
      managedPluginIds: ["codex"],
    });
    deps.reconcileOpenclawPlugins.mockRejectedValue(new Error("npm failed"));
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "openai/gpt-5.5",
        configuredModels: {
          "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
        },
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error:
        "OpenClaw plugin installation failed. Please retry saving model settings; if it persists, check package registry/network access for OpenClaw plugins.",
    });
  });

  it("skips automatic git-sync when GitHub backup is not configured", async () => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousGithubRepo = process.env.GITHUB_WORKSPACE_REPO;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_WORKSPACE_REPO;
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    const app = createApp(deps);

    try {
      const res = await request(app)
        .put("/api/models/config")
        .send({
          primary: "openai-codex/gpt-5.3-codex",
          configuredModels: {
            "openai-codex/gpt-5.3-codex": {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(deps.shellCmd).not.toHaveBeenCalledWith(
        'alphaclaw git-sync -m "models: update config" -f "openclaw.json"',
        { timeout: 30000 },
      );
    } finally {
      if (previousGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGithubToken;
      }
      if (previousGithubRepo === undefined) {
        delete process.env.GITHUB_WORKSPACE_REPO;
      } else {
        process.env.GITHUB_WORKSPACE_REPO = previousGithubRepo;
      }
    }
  });

  it("prefills default api-key auth profiles from env vars on GET /api/models/config", async () => {
    const deps = createModelDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "GEMINI_API_KEY", value: "AI-live-123" },
    ]);
    deps.authProfiles.listApiKeyProviders.mockReturnValue(["google"]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) => (provider === "google" ? "GEMINI_API_KEY" : ""),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/models/config");

    expect(res.status).toBe(200);
    expect(res.body.authProfiles).toEqual([
      {
        id: "google:default",
        type: "api_key",
        provider: "google",
        key: "AI-live-123",
      },
    ]);
  });

  it("returns provider runtime ids on GET /api/models/config", async () => {
    const deps = createModelDeps();
    deps.authProfiles.getModelConfig.mockReturnValue({
      primary: "openai/gpt-5.5",
      configuredModels: { "openai/gpt-5.5": {} },
      providerRuntimeIds: { openai: "codex" },
      modelRuntimeIds: {},
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/models/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        providerRuntimeIds: { openai: "codex" },
        modelRuntimeIds: {},
      }),
    );
  });

  it("writes API-key model auth changes back to env vars", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([{ key: "OPENAI_API_KEY", value: "" }]);
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "openai:default",
            type: "api_key",
            provider: "openai",
            key: "sk-live-123",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "OPENAI_API_KEY", value: "sk-live-123" },
    ]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("rejects Vercel AI Gateway auth profiles with the wrong prefix", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "vercel-ai-gateway:default",
            type: "api_key",
            provider: "vercel-ai-gateway",
            key: "not-a-vercel-key",
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Vercel AI Gateway API key must start with vck_",
    });
    expect(deps.authProfiles.upsertProfile).not.toHaveBeenCalled();
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
  });

  it("rejects model-only Vercel AI Gateway saves with an invalid env-backed key", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([
      { key: "AI_GATEWAY_API_KEY", value: "not-a-vercel-key" },
    ]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) =>
        provider === "vercel-ai-gateway" ? "AI_GATEWAY_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "vercel-ai-gateway/openai/gpt-5.5",
        configuredModels: {
          "vercel-ai-gateway/openai/gpt-5.5": {},
        },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "AI_GATEWAY_API_KEY must start with vck_",
    });
    expect(deps.authProfiles.setModelConfig).not.toHaveBeenCalled();
  });

  it("returns JSON when model-config credential validation reads fail", async () => {
    const deps = createModelDeps();
    deps.readEnvFile.mockImplementation(() => {
      throw new Error("env unreadable");
    });
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) =>
        provider === "vercel-ai-gateway" ? "AI_GATEWAY_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "vercel-ai-gateway/openai/gpt-5.5",
        configuredModels: {
          "vercel-ai-gateway/openai/gpt-5.5": {},
        },
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "env unreadable" });
    expect(deps.authProfiles.setModelConfig).not.toHaveBeenCalled();
  });

  it("does not reject existing stale gateway keys when switching primary away", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([
      { key: "AI_GATEWAY_API_KEY", value: "not-a-vercel-key" },
    ]);
    deps.authProfiles.getModelConfig.mockReturnValue({
      primary: "vercel-ai-gateway/openai/gpt-5.5",
      configuredModels: {
        "vercel-ai-gateway/openai/gpt-5.5": {},
      },
    });
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) =>
        provider === "vercel-ai-gateway" ? "AI_GATEWAY_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "openai/gpt-5.5",
        configuredModels: {
          "openai/gpt-5.5": {},
          "vercel-ai-gateway/openai/gpt-5.5": {},
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.authProfiles.setModelConfig).toHaveBeenCalledWith({
      primary: "openai/gpt-5.5",
      configuredModels: {
        "openai/gpt-5.5": {},
        "vercel-ai-gateway/openai/gpt-5.5": {},
      },
    });
  });

  it("removes API-key env vars when profile key is cleared", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([
      { key: "OPENAI_API_KEY", value: "sk-live-123" },
    ]);
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "openai:default",
            type: "api_key",
            provider: "openai",
            key: "",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("writes newly supported provider API keys back to env vars", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) => (provider === "zai" ? "ZAI_API_KEY" : ""),
    );
    deps.readEnvFile.mockReturnValue([{ key: "ZAI_API_KEY", value: "" }]);
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "zai:default",
            type: "api_key",
            provider: "zai",
            key: "zai-live-123",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "ZAI_API_KEY", value: "zai-live-123" },
    ]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("syncs env-backed api-key profiles into auth storage on PUT /api/models/config", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([
      { key: "GEMINI_API_KEY", value: "AI-live-123" },
    ]);
    deps.authProfiles.listApiKeyProviders.mockReturnValue(["google"]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) => (provider === "google" ? "GEMINI_API_KEY" : ""),
    );
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "google/gemini-3.1-pro-preview",
        configuredModels: {
          "google/gemini-3.1-pro-preview": {},
        },
      });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "google",
      "AI-live-123",
      undefined,
    );
  });
});

describe("server/routes/models vault-brokered keys", () => {
  const kAnthropicPlaceholder = "__agent_vault_anthropic_api_key__";

  const createVaultDeps = () => {
    const deps = createModelDeps();
    deps.hasVaultRuntime = vi.fn(() => true);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation(
      (provider) =>
        provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : provider === "openai"
            ? "OPENAI_API_KEY"
            : "",
    );
    return deps;
  };

  it("reports brokered providers and enforcement in the config payload", async () => {
    const deps = createVaultDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/models/config");

    expect(res.status).toBe(200);
    expect(res.body.vaultBrokering.enforced).toBe(true);
    expect(res.body.vaultBrokering.providers).toContain("anthropic");
    expect(res.body.vaultBrokering.providers).not.toContain("vllm");
  });

  it("rejects raw api keys for brokered providers once the runtime is claimed", async () => {
    const deps = createVaultDeps();
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "anthropic:default",
            type: "api_key",
            provider: "anthropic",
            key: "sk-ant-api03-raw",
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Agent Vault");
    expect(deps.authProfiles.upsertProfile).not.toHaveBeenCalled();

    const authRes = await request(app)
      .put("/api/models/auth/anthropic:default")
      .send({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api03-raw",
      });

    expect(authRes.status).toBe(400);
    expect(authRes.body.error).toContain("Agent Vault");
  });

  it("rejects generic Codex OAuth writes and deletes", async () => {
    const deps = createModelDeps();
    deps.authProfiles.getProfile.mockReturnValue({
      id: "openai:alternate",
      type: "oauth",
      provider: "openai",
      refresh: "broker-marker",
    });
    const app = createApp(deps);
    const credential = {
      type: "oauth",
      provider: "openai",
      access: "access",
      refresh: "durable-refresh",
      expires: 9999999999999,
    };

    const direct = await request(app)
      .put("/api/models/auth/openai:codex-cli")
      .send(credential);
    const bulk = await request(app)
      .put("/api/models/config")
      .send({ profiles: [{ id: "openai:codex-cli", ...credential }] });
    const remove = await request(app).delete(
      "/api/models/auth/openai:alternate",
    );
    const reservedApiKey = await request(app)
      .put("/api/models/auth/openai:codex-cli")
      .send({ type: "api_key", provider: "openai", key: "api-key" });
    const replaceExistingOauth = await request(app)
      .put("/api/models/auth/openai:alternate")
      .send({ type: "api_key", provider: "openai", key: "api-key" });
    const bulkReservedToken = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "openai:codex-cli",
            type: "token",
            provider: "openai",
            token: "token",
          },
        ],
      });
    const normalizedProvider = await request(app)
      .put("/api/models/auth/custom-oauth")
      .send({ ...credential, provider: " OpenAI " });
    const normalizedReservedId = await request(app)
      .put("/api/models/auth/%20OPENAI:CODEX-CLI%20")
      .send({ type: "api_key", provider: "openai", key: "api-key" });

    expect(direct.status).toBe(409);
    expect(bulk.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(reservedApiKey.status).toBe(409);
    expect(replaceExistingOauth.status).toBe(409);
    expect(bulkReservedToken.status).toBe(409);
    expect(normalizedProvider.status).toBe(409);
    expect(normalizedReservedId.status).toBe(409);
    expect(direct.body.error).toContain("Codex account flow");
    expect(deps.authProfiles.upsertProfile).not.toHaveBeenCalled();
    expect(deps.authProfiles.removeProfile).not.toHaveBeenCalled();
    expect(deps.authProfiles.setModelConfig).not.toHaveBeenCalled();
  });

  it("accepts placeholder values and raw keys for non-brokered providers", async () => {
    const deps = createVaultDeps();
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "anthropic:default",
            type: "api_key",
            provider: "anthropic",
            key: kAnthropicPlaceholder,
          },
          {
            id: "vllm:default",
            type: "api_key",
            provider: "vllm",
            key: "raw-local-key",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.upsertProfile).toHaveBeenCalledWith(
      "anthropic:default",
      expect.objectContaining({ key: kAnthropicPlaceholder }),
      undefined,
    );
  });

  it("keeps the raw path open before the vault runtime is claimed", async () => {
    const deps = createVaultDeps();
    deps.hasVaultRuntime.mockReturnValue(false);
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/models/config")
      .send({
        profiles: [
          {
            id: "anthropic:default",
            type: "api_key",
            provider: "anthropic",
            key: "sk-ant-api03-raw",
          },
        ],
      });

    expect(res.status).toBe(200);
  });

  it("rejects vault-key requests for unsupported providers and missing service", async () => {
    const deps = createVaultDeps();
    const app = createApp(deps);

    const unsupported = await request(app)
      .post("/api/models/vault-key")
      .send({ provider: "vllm" });
    expect(unsupported.status).toBe(400);

    const noService = await request(app)
      .post("/api/models/vault-key")
      .send({ provider: "anthropic" });
    expect(noService.status).toBe(409);
  });

  it("activates the placeholder when the vault already brokers the provider", async () => {
    const deps = createVaultDeps();
    deps.agentVaultService = {
      ensureModelProviderAccess: vi.fn(async () => ({
        status: "available",
        provider: "anthropic",
        credentialKey: "ANTHROPIC_API_KEY",
        placeholder: kAnthropicPlaceholder,
      })),
    };
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/vault-key")
      .send({ provider: "anthropic" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "active",
      provider: "anthropic",
      credentialKey: "ANTHROPIC_API_KEY",
    });
    expect(deps.authProfiles.upsertProfile).toHaveBeenCalledWith(
      "anthropic:default",
      { type: "api_key", provider: "anthropic", key: kAnthropicPlaceholder },
      undefined,
    );
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "ANTHROPIC_API_KEY", value: kAnthropicPlaceholder },
    ]);
    expect(deps.reloadEnv).toHaveBeenCalled();
    expect(
      deps.authProfiles.syncConfigAuthReferencesForAgent,
    ).toHaveBeenCalledWith(undefined);
  });

  it("returns the pending proposal when owner approval is required", async () => {
    const deps = createVaultDeps();
    deps.agentVaultService = {
      ensureModelProviderAccess: vi.fn(async () => ({
        status: "proposal_created",
        provider: "anthropic",
        credentialKey: "ANTHROPIC_API_KEY",
        placeholder: kAnthropicPlaceholder,
        proposal: { id: 11, status: "pending", approvalUrl: "https://x" },
      })),
    };
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/vault-key")
      .send({ provider: "anthropic" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      status: "pending",
      provider: "anthropic",
      proposal: { id: 11 },
    });
    expect(deps.authProfiles.upsertProfile).not.toHaveBeenCalled();
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
  });

  it("propagates vault errors with their status codes", async () => {
    const deps = createVaultDeps();
    deps.agentVaultService = {
      ensureModelProviderAccess: vi.fn(async () => {
        throw Object.assign(
          new Error("Agent Vault owner enrollment is not complete"),
          { status: 409 },
        );
      }),
    };
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/vault-key")
      .send({ provider: "anthropic" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("enrollment");
  });
});
