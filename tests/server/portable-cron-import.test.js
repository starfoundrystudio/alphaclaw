const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  importPortableCronStore,
} = require("../../lib/server/onboarding/import/portable-cron-import");

describe("portable cron import", () => {
  it("writes imported jobs directly to the OpenClaw SQLite store", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cron-import-"));
    const priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = openclawDir;
    const storePath = path.join(openclawDir, "cron", "jobs.json");
    const job = {
      id: "portable-job",
      name: "Portable job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 8 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run the report" },
      delivery: { mode: "none" },
      state: {},
    };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [job] }));
    try {
      const result = await importPortableCronStore({ fs, openclawDir });
      expect(result).toEqual({ imported: true, jobCount: 1 });
      expect(fs.existsSync(storePath)).toBe(false);
      expect(fs.existsSync(path.join(openclawDir, "state", "openclaw.sqlite"))).toBe(true);
      const { loadCronStore } = await import("openclaw/plugin-sdk/cron-store-runtime");
      const loaded = await loadCronStore(storePath);
      expect(loaded.jobs).toHaveLength(1);
      expect(loaded.jobs[0]).toMatchObject({ id: "portable-job", name: "Portable job" });
    } finally {
      if (priorStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = priorStateDir;
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
