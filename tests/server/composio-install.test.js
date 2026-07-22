const path = require("path");
const {
  kInstallCommand,
  ensureComposioOnPath,
  ensureComposioCliInstalled,
  isComposioInstalling,
  getComposioInstallError,
} = require("../../lib/server/composio-install");

// The module tracks one shared install at a time; each test awaits its
// install promise, so no cross-test state leaks.

const createExecFake = ({ cliPresentInitially = false, installSucceeds = true }) => {
  let cliPresent = cliPresentInitially;
  const calls = [];
  const execFn = (command, _opts, callback) => {
    calls.push(command);
    if (command === "command -v composio") {
      return callback(cliPresent ? null : new Error("not found"), "", "");
    }
    if (command === kInstallCommand) {
      if (installSucceeds) cliPresent = true;
      return callback(
        installSucceeds ? null : new Error("exit 1"),
        "",
        installSucceeds ? "" : "curl: (22) The requested URL returned error: 500",
      );
    }
    return callback(null, "", "");
  };
  return { execFn, calls };
};

const kNoBinaryFs = { existsSync: () => false };

describe("server/composio-install", () => {
  const kOriginalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = kOriginalPath;
  });

  it("ensureComposioOnPath prepends the composio dir when the binary exists", () => {
    const fs = {
      existsSync: (p) => String(p) === path.join("/home/test", ".composio", "composio"),
    };
    expect(ensureComposioOnPath({ fs, homedir: "/home/test" })).toBe(true);
    expect(process.env.PATH.split(":")[0]).toBe(path.join("/home/test", ".composio"));
  });

  it("short-circuits when the CLI is already available", async () => {
    const { execFn, calls } = createExecFake({ cliPresentInitially: true });
    const result = await ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn });
    expect(result).toEqual({ installed: true, alreadyInstalled: true });
    expect(calls).toEqual(["command -v composio"]);
  });

  it("runs the official install script and rechecks availability", async () => {
    const { execFn, calls } = createExecFake({ installSucceeds: true });
    const onComplete = vi.fn();
    const result = await ensureComposioCliInstalled({
      fs: kNoBinaryFs,
      execFn,
      onComplete,
    });
    expect(result).toEqual({ installed: true });
    expect(calls).toContain(kInstallCommand);
    expect(onComplete).toHaveBeenCalled();
    expect(getComposioInstallError()).toBe("");
  });

  it("records the failure when the install does not produce a binary", async () => {
    const { execFn } = createExecFake({ installSucceeds: false });
    const result = await ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn });
    expect(result.installed).toBe(false);
    expect(result.error).toContain("curl: (22)");
    expect(getComposioInstallError()).toContain("curl: (22)");
    // Recover module state for later tests
    const { execFn: okFn } = createExecFake({ cliPresentInitially: true });
    await ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn: okFn });
  });

  it("shares a single in-flight install between concurrent callers", async () => {
    let resolveCheck;
    const gate = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const execFn = async (command, _opts, callback) => {
      if (command === "command -v composio") {
        await gate;
        return callback(null, "", "");
      }
      return callback(null, "", "");
    };
    const first = ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn });
    expect(isComposioInstalling()).toBe(true);
    const second = ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn });
    expect(second).toBe(first);
    resolveCheck();
    await first;
    expect(isComposioInstalling()).toBe(false);
  });
});
