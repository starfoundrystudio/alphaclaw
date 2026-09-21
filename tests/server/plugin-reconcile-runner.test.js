const { EventEmitter } = require("events");
const {
  createPluginReconcileRunner,
  describeReconcileFailure,
} = require("../../lib/server/plugin-reconcile-runner");
const {
  stripOpenclawNoise,
  summarizeOpenclawFailure,
} = require("../../lib/server/openclaw-cli-output");

const kWarnings =
  '[config] warnings: plugins.deny: plugin not found: buzz (stale config entry ignored; remove it from plugins config); agents.entries: Removed retired agents.entries.*.default markers.';

const fakeChild = ({ code = 0, stdout = "", stderr = "" }) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
};

describe("server/plugin-reconcile-runner", () => {
  it("runs the targeted reconcile in a child process", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ code: 0 }));
    const run = createPluginReconcileRunner({ rootDir: "/r", binPath: "/b.js", spawnImpl, wait: async () => {} });
    await expect(run({ onlyPluginKeys: ["slack"] })).resolves.toEqual({ ok: true, attempt: 1 });
    const [, args] = spawnImpl.mock.calls[0];
    expect(args).toEqual(["/b.js", "--root-dir", "/r", "reconcile-openclaw-plugins", "--only", "slack"]);
  });

  it("retries once and succeeds", async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(() => fakeChild({ code: 1, stderr: "npm view failed" }))
      .mockImplementationOnce(() => fakeChild({ code: 0 }));
    const run = createPluginReconcileRunner({ rootDir: "/r", spawnImpl, wait: async () => {}, logger: { warn: () => {} } });
    await expect(run({ onlyPluginKeys: ["slack"] })).resolves.toEqual({ ok: true, attempt: 2 });
  });

  it("gives up after the retry with a readable reason, not the warning wall", async () => {
    const stderr = `${kWarnings}\n[alphaclaw] OpenClaw plugin reconciliation failed: ${kWarnings}\nnpm view failed: npm warn Unknown user config "always-auth".`;
    const spawnImpl = vi.fn(() => fakeChild({ code: 1, stderr }));
    const run = createPluginReconcileRunner({ rootDir: "/r", spawnImpl, wait: async () => {}, logger: { warn: () => {} } });
    await expect(run({ onlyPluginKeys: ["slack"] })).rejects.toThrow(
      "Downloading the OpenClaw plugin from npm failed or timed out. Try again in a moment.",
    );
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("describes other failures by their first real line", () => {
    expect(
      describeReconcileFailure({
        stderr: `[alphaclaw] OpenClaw plugin reconciliation failed: ${kWarnings}\nPlugin "slack" requires capability consent.`,
      }),
    ).toBe('OpenClaw plugin installation failed: Plugin "slack" requires capability consent.');
    expect(describeReconcileFailure({ timedOut: true })).toMatch(/took too long/);
  });
});

describe("server/openclaw-cli-output", () => {
  it("strips OpenClaw config warnings, notices and npm warnings", () => {
    expect(
      stripOpenclawNoise(
        `${kWarnings}\nConfig (/x/openclaw.json): Removed retired markers.\nnpm warn old config\nAdded Slack account "default".`,
      ),
    ).toBe('Added Slack account "default".');
  });

  it("summarizes a failed command without echoing the command line", () => {
    expect(summarizeOpenclawFailure({ ok: false, stderr: kWarnings, message: "Command failed: openclaw channels add --bot-token xoxb-secret" }))
      .toBe("OpenClaw command failed");
    expect(summarizeOpenclawFailure({ ok: false, stderr: `${kWarnings}\nError: channel "slack" is not supported` }))
      .toBe('Error: channel "slack" is not supported');
    expect(summarizeOpenclawFailure({ ok: false, killed: true, signal: "SIGTERM", timedOut: true, stderr: kWarnings }))
      .toBe("OpenClaw did not finish in time. Try again in a moment.");
  });
});
