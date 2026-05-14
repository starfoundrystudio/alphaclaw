const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCronService } = require("../../lib/server/cron-service");

const createOpenclawDirWithCronJobs = (jobs = []) => {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cron-"));
  fs.mkdirSync(path.join(openclawDir, "cron"), { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "cron", "jobs.json"),
    JSON.stringify({ version: 1, jobs }),
    "utf8",
  );
  return openclawDir;
};

describe("server/cron-service", () => {
  it("uses plain cron commands without --json for run/toggle/edit", async () => {
    const openclawDir = createOpenclawDirWithCronJobs([
      {
        id: "job-a",
        name: "Job A",
        enabled: true,
        createdAtMs: 1,
        schedule: { kind: "cron", expr: "0 8 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "old prompt" },
        state: {},
      },
    ]);
    const clawCmd = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: "ran job-a" })
      .mockResolvedValueOnce({ ok: true, stdout: "disabled job-a" })
      .mockResolvedValueOnce({ ok: true, stdout: "enabled job-a" })
      .mockResolvedValueOnce({ ok: true, stdout: "updated prompt" })
      .mockResolvedValueOnce({ ok: true, stdout: "updated routing" });
    try {
      const cronService = createCronService({
        clawCmd,
        OPENCLAW_DIR: openclawDir,
        getSessionUsageByKeyPattern: vi.fn(() => ({})),
      });

      const runResult = await cronService.runJobNow("job-a");
      expect(clawCmd).toHaveBeenCalledTimes(1);
      expect(clawCmd).toHaveBeenNthCalledWith(
        1,
        "cron run 'job-a'",
        expect.objectContaining({ quiet: true }),
      );
      expect(runResult.raw).toBe("ran job-a");

      const result = await cronService.setJobEnabled({
        jobId: "job-a",
        enabled: false,
      });

      expect(clawCmd).toHaveBeenCalledTimes(2);
      expect(clawCmd).toHaveBeenNthCalledWith(
        2,
        "cron disable 'job-a'",
        expect.objectContaining({ quiet: true }),
      );
      expect(result.raw).toBe("disabled job-a");
      expect(result.parsed).toBeNull();

      const secondResult = await cronService.setJobEnabled({
        jobId: "job-a",
        enabled: true,
      });
      expect(clawCmd).toHaveBeenCalledTimes(3);
      expect(clawCmd).toHaveBeenNthCalledWith(
        3,
        "cron enable 'job-a'",
        expect.objectContaining({ quiet: true }),
      );
      expect(secondResult.raw).toBe("enabled job-a");

      const promptResult = await cronService.updateJobPrompt({
        jobId: "job-a",
        message: "hello world",
      });
      expect(clawCmd).toHaveBeenCalledTimes(4);
      expect(clawCmd).toHaveBeenNthCalledWith(
        4,
        "cron edit 'job-a' --message 'hello world'",
        expect.objectContaining({ quiet: true }),
      );
      expect(promptResult.raw).toBe("updated prompt");

      const routingResult = await cronService.updateJobRouting({
        jobId: "job-a",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        deliveryMode: "announce",
        deliveryChannel: "telegram",
        deliveryTo: "123",
      });
      expect(clawCmd).toHaveBeenCalledTimes(5);
      expect(clawCmd).toHaveBeenNthCalledWith(
        5,
        "cron edit 'job-a' --session 'isolated' --wake 'next-heartbeat' --announce --channel 'telegram' --to '123'",
        expect.objectContaining({ quiet: true }),
      );
      expect(routingResult.raw).toBe("updated routing");
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("uses --system-event when editing main systemEvent job prompts", async () => {
    const openclawDir = createOpenclawDirWithCronJobs([
      {
        id: "job-main",
        name: "Main Job",
        enabled: true,
        createdAtMs: 1,
        schedule: { kind: "cron", expr: "0 8 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "old prompt" },
        state: {},
      },
    ]);
    try {
      const clawCmd = vi.fn().mockResolvedValue({ ok: true, stdout: "updated prompt" });
      const cronService = createCronService({
        clawCmd,
        OPENCLAW_DIR: openclawDir,
        getSessionUsageByKeyPattern: vi.fn(() => ({})),
      });

      const result = await cronService.updateJobPrompt({
        jobId: "job-main",
        message: "new prompt",
      });

      expect(clawCmd).toHaveBeenCalledWith(
        "cron edit 'job-main' --system-event 'new prompt'",
        expect.objectContaining({ quiet: true }),
      );
      expect(result.raw).toBe("updated prompt");
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
