const {
  kTailnetManagerRequestPath,
  kTailnetManagerCapabilityPath,
  kTailnetManagerStatusPath,
  createTailnetHostManager,
  parseManagerJson,
} = require("../../lib/server/tailscale/host-manager");

describe("server/tailscale/host-manager", () => {
  it("parses manager JSON and rejects invalid output", () => {
    expect(parseManagerJson('{"ok":true}', "capability")).toEqual({ ok: true });
    expect(() => parseManagerJson("not-json", "status")).toThrow(
      "returned invalid JSON",
    );
  });

  it("stages the sealed request without invoking a privileged command", async () => {
    const writes = [];
    const fs = {
      readFileSync: vi.fn((filePath) => {
        if (filePath === kTailnetManagerCapabilityPath) {
          return '{"ok":true,"requestVersion":2}';
        }
        if (filePath === kTailnetManagerStatusPath) {
          return '{"ok":true,"version":2,"operationId":"op-1","state":"queued"}';
        }
        throw new Error(`Unexpected read: ${filePath}`);
      }),
      writeFileSync: vi.fn((filePath, value, options) => {
        writes.push({ filePath, value, options });
      }),
      renameSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const manager = createTailnetHostManager({ fs });

    const result = await manager.stageAndSchedule({
      operationId: "op-1",
      authKey: "tskey-auth-super-secret",
    });

    expect(result).toMatchObject({
      ok: true,
      version: 2,
      operationId: "op-1",
      state: "queued",
    });
    expect(writes[0].value).toContain("tskey-auth-super-secret");
    expect(writes[0].options.mode).toBe(0o600);
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining(`${kTailnetManagerRequestPath}.`),
      kTailnetManagerRequestPath,
    );
  });

  it("waits through dispatcher pickup until the root worker is queued", async () => {
    const sleep = vi.fn(async () => {});
    let statusReads = 0;
    const fs = {
      readFileSync: vi.fn((filePath) => {
        if (filePath === kTailnetManagerCapabilityPath) {
          return '{"ok":true,"requestVersion":2}';
        }
        if (filePath === kTailnetManagerStatusPath) {
          statusReads += 1;
          return statusReads === 1
            ? '{"ok":true,"version":2,"operationId":"op-2","state":"dispatching"}'
            : '{"ok":true,"version":2,"operationId":"op-2","state":"queued"}';
        }
        throw new Error(`Unexpected read: ${filePath}`);
      }),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const manager = createTailnetHostManager({ fs, sleep });

    await expect(
      manager.stageAndSchedule({ operationId: "op-2" }),
    ).resolves.toMatchObject({ operationId: "op-2", state: "queued" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("reports a missing capability file without exposing a filesystem error", async () => {
    const fs = {
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error("permission details"), { code: "ENOENT" });
      }),
    };
    const manager = createTailnetHostManager({ fs });

    await expect(manager.check()).resolves.toMatchObject({
      ok: false,
      available: false,
      error: "Change Tailnet requires a clawctl host upgrade before it can run.",
    });
  });

  it("removes an unconsumed sealed request when the dispatcher does not acknowledge it", async () => {
    const fs = {
      readFileSync: vi.fn((filePath) => {
        if (filePath === kTailnetManagerCapabilityPath) {
          return '{"ok":true,"requestVersion":2}';
        }
        if (filePath === kTailnetManagerStatusPath) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        if (filePath === kTailnetManagerRequestPath) {
          return '{"version":2,"operationId":"op-timeout"}';
        }
        throw new Error(`Unexpected read: ${filePath}`);
      }),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const manager = createTailnetHostManager({
      fs,
      sleep: vi.fn(async () => {}),
      scheduleAckAttempts: 1,
    });

    await expect(
      manager.stageAndSchedule({ operationId: "op-timeout" }),
    ).rejects.toThrow("did not acknowledge");
    expect(fs.rmSync).toHaveBeenCalledWith(kTailnetManagerRequestPath, {
      force: true,
    });
  });

  it("rejects an installed helper with the older request contract", async () => {
    const manager = createTailnetHostManager({
      fs: {
        readFileSync: vi.fn(() => '{"ok":true,"requestVersion":1}'),
      },
    });

    await expect(manager.check()).resolves.toMatchObject({
      ok: false,
      available: true,
      compatible: false,
      requestVersion: 1,
    });
  });

  it("reads sanitized status directly and treats a missing status as idle", async () => {
    const fs = {
      readFileSync: vi.fn((filePath) => {
        if (filePath === kTailnetManagerStatusPath) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return '{"ok":true,"requestVersion":2}';
      }),
    };
    const manager = createTailnetHostManager({ fs });

    await expect(manager.getStatus()).resolves.toMatchObject({
      ok: true,
      version: 2,
      state: "idle",
      operationId: null,
    });
  });
});
