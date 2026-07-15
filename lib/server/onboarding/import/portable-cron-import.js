const path = require("path");

const importPortableCronStore = async ({ fs, openclawDir }) => {
  const storePath = path.join(openclawDir, "cron", "jobs.json");
  if (!fs.existsSync(storePath)) return { imported: false, jobCount: 0 };
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
  if (!Array.isArray(jobs)) {
    throw new Error("Portable cron export must contain a jobs array");
  }
  const { saveCronStore } = await import("openclaw/plugin-sdk/cron-store-runtime");
  await saveCronStore(storePath, { version: 1, jobs });
  fs.rmSync(storePath, { force: true });
  return { imported: true, jobCount: jobs.length };
};

module.exports = { importPortableCronStore };
