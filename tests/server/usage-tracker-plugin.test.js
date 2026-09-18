const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

describe("usage-tracker OpenClaw 2026.9.4 hook contract", () => {
  let rootDir;
  let previousRootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-usage-plugin-"));
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
    process.env.ALPHACLAW_ROOT_DIR = rootDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousRootDir === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
    else process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("records current llm_output and tool_result_persist payloads", () => {
    const hooks = {};
    const plugin = require("../../lib/plugin/usage-tracker");
    plugin.register({
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: (name, handler) => {
        hooks[name] = handler;
      },
    });

    hooks.llm_output(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.6-sol",
        assistantTexts: ["done"],
        usage: { input: 12, output: 5, cacheRead: 3, total: 20 },
      },
      { sessionKey: "agent:main:main" },
    );
    expect(
      hooks.tool_result_persist(
        {
          toolName: "web_search",
          toolCallId: "call-1",
          message: { role: "tool", content: "ok" },
          isSynthetic: false,
        },
        { sessionKey: "agent:main:main", toolName: "web_search" },
      ),
    ).toEqual({});

    const database = new DatabaseSync(path.join(rootDir, "db", "usage.db"), {
      readOnly: true,
    });
    expect(database.prepare("SELECT * FROM usage_events").get()).toMatchObject({
      run_id: "run-1",
      session_id: "session-1",
      session_key: "agent:main:main",
      provider: "openai",
      model: "gpt-5.6-sol",
      total_tokens: 20,
    });
    expect(database.prepare("SELECT * FROM tool_events").get()).toMatchObject({
      session_key: "agent:main:main",
      tool_name: "web_search",
      success: 1,
    });
    database.close();
  });
});
