const {
  kTailnetManagerPath,
  kTailnetManagerRequestPath,
  createTailnetHostManager,
  isManagerUnavailableError,
  parseManagerJson,
} = require("../../lib/server/tailscale/host-manager");

describe("server/tailscale/host-manager", () => {
  it("parses manager JSON and rejects invalid output", () => {
    expect(parseManagerJson('{"ok":true}', "check")).toEqual({ ok: true });
    expect(() => parseManagerJson("not-json", "status")).toThrow(
      "returned invalid JSON",
    );
  });

  it("recognizes hosts without the clawctl helper", () => {
    expect(isManagerUnavailableError(new Error("sudo: command not found"))).toBe(
      true,
    );
    expect(isManagerUnavailableError(new Error("operation failed"))).toBe(false);
  });

  it("stages the secret request without putting it on the command line", async () => {
    const writes = [];
    const fs = {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((filePath, value, options) => {
        writes.push({ filePath, value, options });
      }),
      renameSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const shellCmd = vi.fn(async (command) => {
      if (command.endsWith(" check")) {
        return '{"ok":true,"requestVersion":2}';
      }
      if (command.endsWith(" schedule")) return '{"ok":true,"state":"queued"}';
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = createTailnetHostManager({ shellCmd, fs });

    const result = await manager.stageAndSchedule({
      operationId: "op-1",
      authKey: "tskey-auth-super-secret",
    });

    expect(result.ok).toBe(true);
    expect(shellCmd).toHaveBeenCalledWith(
      `sudo -n ${kTailnetManagerPath} schedule`,
      expect.any(Object),
    );
    expect(shellCmd.mock.calls.flat().join(" ")).not.toContain(
      "tskey-auth-super-secret",
    );
    expect(writes[0].value).toContain("tskey-auth-super-secret");
    expect(writes[0].options.mode).toBe(0o600);
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining(`${kTailnetManagerRequestPath}.`),
      kTailnetManagerRequestPath,
    );
  });

  it("reports an unavailable optional capability without throwing", async () => {
    const error = Object.assign(new Error("helper missing"), {
      stderr: "sudo: /usr/local/sbin/alphaclaw-tailnet-manager: command not found",
    });
    const manager = createTailnetHostManager({
      shellCmd: vi.fn(async () => {
        throw error;
      }),
      fs: {},
    });

    await expect(manager.check({ required: false })).resolves.toMatchObject({
      ok: false,
      available: false,
    });
  });

  it("rejects an installed helper with the older request contract", async () => {
    const manager = createTailnetHostManager({
      shellCmd: vi.fn(async () => '{"ok":true,"requestVersion":1}'),
      fs: {},
    });

    await expect(manager.check()).resolves.toMatchObject({
      ok: false,
      available: true,
      compatible: false,
      requestVersion: 1,
    });
  });
});
