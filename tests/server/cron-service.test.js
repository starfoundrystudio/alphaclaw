const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCronService } = require("../../lib/server/cron-service");

const kAgentJob = {
  id: "job-a",
  name: "Job A",
  displayName: "Daily report",
  owner: { agentId: "main", sessionKey: "agent:main:main" },
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 2,
  schedule: { kind: "on-exit", command: "node worker.js", cwd: "/workspace" },
  sessionTarget: "current",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "old prompt" },
  delivery: { mode: "webhook", to: "https://example.test/hook" },
  state: {},
};

describe("server/cron-service", () => {
  it("consumes the 2026.7.1 SQLite-backed cron store through Gateway RPC", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cron-sqlite-"));
    const priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const logicalStorePath = path.join(stateDir, "cron", "jobs.json");
    try {
      const { loadCronStore, saveCronStore } = await import(
        "openclaw/plugin-sdk/cron-store-runtime"
      );
      await saveCronStore(logicalStorePath, { version: 1, jobs: [kAgentJob] });
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
      expect(fs.existsSync(logicalStorePath)).toBe(false);

      const requestGateway = vi.fn(async (method, params) => {
        if (method === "cron.list") {
          const store = await loadCronStore(logicalStorePath);
          return {
            jobs: store.jobs,
            total: store.jobs.length,
            offset: params.offset,
            limit: params.limit,
            hasMore: false,
            nextOffset: null,
          };
        }
        if (method === "cron.status") {
          return { enabled: true, jobs: 1, nextWakeAtMs: null };
        }
        if (method === "cron.runs") {
          return {
            entries: [
              {
                ts: 100,
                jobId: "job-a",
                action: "finished",
                status: "ok",
                durationMs: 500,
                provider: "openai",
                model: "gpt-5",
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            ],
            total: 1,
            offset: params.offset,
            limit: params.limit,
            hasMore: false,
            nextOffset: null,
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const cronService = createCronService({
        requestGateway,
        getSessionUsageByKeyPattern: vi.fn(() => ({
          totals: { runCount: 1, totalTokens: 15, totalCost: 0 },
        })),
      });

      const listed = await cronService.listJobs();
      expect(listed.jobs).toHaveLength(1);
      expect(listed.jobs[0]).toMatchObject({
        id: "job-a",
        displayName: "Daily report",
        schedule: { kind: "on-exit" },
        sessionTarget: "isolated",
        delivery: { mode: "webhook" },
      });
      expect(await cronService.getStatus()).toMatchObject({ enabled: true, jobs: 1 });
      const runs = await cronService.getJobRuns({ jobId: "job-a" });
      expect(runs.entries).toHaveLength(1);
      expect(runs.nextOffset).toBeNull();
      const usage = await cronService.getJobUsage({ jobId: "job-a" });
      expect(usage.totals).toMatchObject({ totalDurationMs: 500, durationSamples: 1 });
      expect(requestGateway).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ includeDisabled: true, limit: 200 }),
      );
      expect(requestGateway).toHaveBeenCalledWith(
        "cron.runs",
        expect.objectContaining({ scope: "job", id: "job-a" }),
      );
    } finally {
      if (priorStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = priorStateDir;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses Gateway mutations and preserves 2026.7.1 routing values", async () => {
    const requestGateway = vi.fn(async (method) => {
      if (method === "cron.get") return kAgentJob;
      return { ok: true };
    });
    const cronService = createCronService({
      requestGateway,
      getSessionUsageByKeyPattern: vi.fn(() => ({})),
    });

    await cronService.runJobNow("job-a");
    await cronService.setJobEnabled({ jobId: "job-a", enabled: false });
    await cronService.updateJobPrompt({ jobId: "job-a", message: "hello world" });
    await cronService.updateJobRouting({
      jobId: "job-a",
      sessionTarget: "session:abc123",
      wakeMode: "next-heartbeat",
      deliveryMode: "webhook",
      deliveryTo: "https://example.test/hook",
    });

    expect(requestGateway).toHaveBeenCalledWith(
      "cron.run",
      { id: "job-a", mode: "force" },
      600000,
    );
    expect(requestGateway).toHaveBeenCalledWith("cron.update", {
      id: "job-a",
      patch: { enabled: false },
    }, undefined);
    expect(requestGateway).toHaveBeenCalledWith("cron.update", {
      id: "job-a",
      patch: { payload: { kind: "agentTurn", message: "hello world" } },
    }, undefined);
    expect(requestGateway).toHaveBeenCalledWith("cron.update", {
      id: "job-a",
      patch: {
        sessionTarget: "session:abc123",
        wakeMode: "next-heartbeat",
        delivery: { mode: "webhook", to: "https://example.test/hook" },
      },
    }, undefined);
  });

  it("updates systemEvent prompts without consulting legacy jobs.json", async () => {
    const requestGateway = vi.fn(async (method) => {
      if (method === "cron.get") {
        return { ...kAgentJob, id: "job-main", payload: { kind: "systemEvent", text: "old" } };
      }
      return { id: "job-main" };
    });
    const cronService = createCronService({
      requestGateway,
      getSessionUsageByKeyPattern: vi.fn(() => ({})),
    });

    await cronService.updateJobPrompt({ jobId: "job-main", message: "new prompt" });

    expect(requestGateway).toHaveBeenLastCalledWith("cron.update", {
      id: "job-main",
      patch: { payload: { kind: "systemEvent", text: "new prompt" } },
    }, undefined);
  });
});
