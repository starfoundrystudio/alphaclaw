const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readOpenclawConfig,
  stripRetiredOpenclawConfigKeys,
  writeOpenclawConfig,
} = require("../../lib/server/openclaw-config");

describe("server/openclaw-config", () => {
  describe("stripRetiredOpenclawConfigKeys", () => {
    it("drops the keys retired by OpenClaw 2026.9 without touching siblings", () => {
      const input = {
        agents: {
          defaults: {
            memorySearch: { provider: "local", local: { contextSize: 2048 } },
            model: { primary: "openai/gpt-5.6-sol" },
          },
          entries: { main: { name: "Main" } },
        },
        plugins: { bundledDiscovery: "compat", allow: ["memory-core"] },
        memory: { search: { provider: "local" } },
      };
      const before = JSON.stringify(input);

      const next = stripRetiredOpenclawConfigKeys(input);

      expect(next.agents.defaults).toEqual({
        model: { primary: "openai/gpt-5.6-sol" },
      });
      expect(next.agents.entries).toEqual({ main: { name: "Main" } });
      expect(next.plugins).toEqual({ allow: ["memory-core"] });
      expect(next.memory).toEqual({ search: { provider: "local" } });
      // The caller's object is left alone.
      expect(JSON.stringify(input)).toBe(before);
    });

    it("returns configs without the keys unchanged", () => {
      const input = { agents: { defaults: { model: {} } }, plugins: {} };
      expect(stripRetiredOpenclawConfigKeys(input)).toEqual(input);
      expect(stripRetiredOpenclawConfigKeys(null)).toBeNull();
    });
  });

  describe("writeOpenclawConfig", () => {
    it("never persists the retired keys, whichever caller wrote them", () => {
      // G2 finding #1 (2026-09-18): a runtime writer re-added these keys from
      // a stale copy minutes after boot and every later OpenClaw CLI call and
      // Gateway config reload refused the file.
      const openclawDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "alphaclaw-openclaw-config-"),
      );
      try {
        writeOpenclawConfig({
          openclawDir,
          config: {
            agents: {
              defaults: {
                memorySearch: { provider: "local" },
                maxConcurrent: 3,
              },
            },
            plugins: { bundledDiscovery: "compat", entries: { meta: {} } },
            gateway: { mode: "local" },
          },
        });

        const written = readOpenclawConfig({ openclawDir });
        expect(written).toEqual({
          agents: { defaults: { maxConcurrent: 3 } },
          plugins: { entries: { meta: {} } },
          gateway: { mode: "local" },
        });
      } finally {
        fs.rmSync(openclawDir, { recursive: true, force: true });
      }
    });
  });
});
