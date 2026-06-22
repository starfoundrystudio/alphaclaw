const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { createUiSandboxServer } = require("../../lib/server/ui-sandbox/server");

const createSandbox = (options = {}) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-ui-sandbox-test-"));
  const sandbox = createUiSandboxServer({
    port: 3101,
    workspaceRoot,
    ...options,
  });
  return {
    ...sandbox,
    workspaceRoot,
    cleanup: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
};

describe("server/ui-sandbox", () => {
  it("starts dashboard mode as already onboarded", async () => {
    const sandbox = createSandbox({ mode: "dashboard", scenario: "healthy" });
    try {
      const res = await request(sandbox.app).get("/api/onboard/status");

      expect(res.status).toBe(200);
      expect(res.body.onboarded).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("starts setup mode as not onboarded and flips after mocked setup", async () => {
    const sandbox = createSandbox({ mode: "setup", scenario: "setup" });
    try {
      const before = await request(sandbox.app).get("/api/onboard/status");
      expect(before.body.onboarded).toBe(false);

      const setup = await request(sandbox.app)
        .post("/api/onboard")
        .send({
          vars: [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-sandbox" }],
          modelKey: "anthropic/claude-opus-4-8",
          tailscaleApiToken: "tskey-api-sandbox_123456789",
        });
      expect(setup.status).toBe(200);
      expect(setup.body).toMatchObject({ ok: true, sandbox: true });
      expect(setup.body.setupUrl).toContain("localhost:3101");

      const after = await request(sandbox.app).get("/api/onboard/status");
      expect(after.body.onboarded).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("serves sandbox status with uiSandbox metadata", async () => {
    const sandbox = createSandbox({ mode: "dashboard", scenario: "attention" });
    try {
      const res = await request(sandbox.app).get("/api/status");

      expect(res.status).toBe(200);
      expect(res.body.uiSandbox).toEqual({
        enabled: true,
        scenario: "attention",
        mode: "dashboard",
      });
      expect(res.body.gateway).toBe("starting");
    } finally {
      sandbox.cleanup();
    }
  });

  it("keeps mutations in memory only", async () => {
    const sandbox = createSandbox({ mode: "dashboard", scenario: "healthy" });
    try {
      const nextVars = [{ key: "SANDBOX_ONLY", value: "1" }];
      const save = await request(sandbox.app).put("/api/env").send({ vars: nextVars });
      expect(save.body).toMatchObject({ ok: true, changed: true });

      const read = await request(sandbox.app).get("/api/env");
      expect(read.body.vars).toEqual(nextVars);
      expect(fs.existsSync(path.join(sandbox.workspaceRoot, ".env"))).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses the generated workspace for real browse APIs", async () => {
    const sandbox = createSandbox({ mode: "dashboard", scenario: "healthy" });
    try {
      const tree = await request(sandbox.app).get("/api/browse/tree").query({ depth: 2 });
      expect(tree.status).toBe(200);
      expect(tree.body.root.children.map((entry) => entry.name)).toContain("openclaw.json");

      const read = await request(sandbox.app)
        .get("/api/browse/read")
        .query({ path: "README.md" });
      expect(read.status).toBe(200);
      expect(read.body.content).toContain("AlphaClaw UI Sandbox");

      const git = await request(sandbox.app).get("/api/browse/git-summary");
      expect(git.status).toBe(200);
      expect(git.body.isRepo).toBe(true);
      expect(git.body.changedFilesCount).toBeGreaterThan(0);
    } finally {
      sandbox.cleanup();
    }
  });
});
