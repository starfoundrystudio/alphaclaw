const path = require("path");
const {
  kInstallCommand,
  composioPlatformToken,
  composioReleaseAssetUrl,
  parseComposioVersion,
  compareComposioVersions,
  ensureComposioOnPath,
  ensureComposioCliInstalled,
  ensureComposioCliAtVersion,
  ensureComposioListenFlag,
  isComposioInstalling,
  isComposioUpgrading,
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

  describe("version helpers", () => {
    it("parses plain and beta versions", () => {
      expect(parseComposioVersion("0.2.32").raw).toBe("0.2.32");
      expect(parseComposioVersion("0.2.33-beta.298")).toMatchObject({
        numbers: [0, 2, 33],
        beta: 298,
      });
      expect(parseComposioVersion("no version here")).toBeNull();
    });

    it("compares versions with beta sorting below the release", () => {
      expect(compareComposioVersions("0.2.32", "0.2.33")).toBe(-1);
      expect(compareComposioVersions("0.2.33", "0.2.33")).toBe(0);
      expect(compareComposioVersions("0.2.33-beta.298", "0.2.33")).toBe(-1);
      expect(compareComposioVersions("0.2.33", "0.2.33-beta.298")).toBe(1);
      expect(compareComposioVersions("0.2.33-beta.5", "0.2.33-beta.10")).toBe(-1);
      expect(compareComposioVersions("0.3.0", "0.2.99")).toBe(1);
    });

    it("builds platform tokens matching the official install script", () => {
      expect(composioPlatformToken({ platform: "darwin", arch: "arm64" })).toBe("darwin-aarch64");
      expect(composioPlatformToken({ platform: "linux", arch: "x64" })).toBe("linux-x64");
      expect(composioPlatformToken({ platform: "linux", arch: "arm64" })).toBe("linux-aarch64");
      expect(composioReleaseAssetUrl("0.2.33", "linux-x64")).toBe(
        "https://github.com/ComposioHQ/composio/releases/download/%40composio%2Fcli%400.2.33/composio-linux-x64.zip",
      );
    });
  });

  describe("ensureComposioCliAtVersion", () => {
    const createUpgradeFake = ({ startVersion = "0.2.32", upgradeSucceeds = true } = {}) => {
      let version = startVersion;
      const calls = [];
      const execFn = (command, _opts, callback) => {
        calls.push(command);
        if (command === "command -v composio") return callback(null, "", "");
        if (command === "composio version") return callback(null, version, "");
        if (command.includes("releases/download")) {
          if (upgradeSucceeds) version = "0.2.33";
          return callback(
            upgradeSucceeds ? null : new Error("exit 1"),
            "",
            upgradeSucceeds ? "" : "curl: (56) connection reset",
          );
        }
        return callback(null, "", "");
      };
      return { execFn, calls };
    };

    it("upgrades an outdated CLI: stops listener, replaces binary, restarts", async () => {
      const { execFn, calls } = createUpgradeFake();
      const order = [];
      const result = await ensureComposioCliAtVersion({
        fs: kNoBinaryFs,
        execFn,
        homedir: "/home/test",
        targetVersion: "0.2.33",
        platform: "linux",
        arch: "x64",
        tmpdir: "/tmp",
        stopListener: async () => order.push("stop"),
        startListener: () => order.push("start"),
        onComplete: async () => order.push("refresh"),
      });
      expect(result).toMatchObject({ upgraded: true, installed: "0.2.33" });
      const upgradeCommand = calls.find((cmd) => cmd.includes("releases/download"));
      expect(upgradeCommand).toContain("composio-linux-x64.zip");
      expect(upgradeCommand).toContain('mv -f "/home/test/.composio/composio.new" "/home/test/.composio/composio"');
      expect(upgradeCommand).toContain("release-tag.txt");
      expect(order).toEqual(["stop", "refresh", "start"]);
    });

    it("no-ops when already at or above the target", async () => {
      const { execFn, calls } = createUpgradeFake({ startVersion: "0.2.33" });
      const stopListener = vi.fn();
      const result = await ensureComposioCliAtVersion({
        fs: kNoBinaryFs,
        execFn,
        homedir: "/home/test",
        targetVersion: "0.2.33",
        stopListener,
      });
      expect(result).toMatchObject({ upToDate: true });
      expect(stopListener).not.toHaveBeenCalled();
      expect(calls.some((cmd) => cmd.includes("releases/download"))).toBe(false);
    });

    it("leaves install responsibility to the install path when CLI missing", async () => {
      const execFn = (command, _opts, callback) =>
        callback(command === "command -v composio" ? new Error("nope") : null, "", "");
      const result = await ensureComposioCliAtVersion({
        fs: kNoBinaryFs,
        execFn,
        homedir: "/home/test",
        targetVersion: "0.2.33",
      });
      expect(result).toMatchObject({ notInstalled: true });
    });

    it("records failure and still restarts the listener", async () => {
      const { execFn } = createUpgradeFake({ upgradeSucceeds: false });
      const startListener = vi.fn();
      const result = await ensureComposioCliAtVersion({
        fs: kNoBinaryFs,
        execFn,
        homedir: "/home/test",
        targetVersion: "0.2.33",
        platform: "linux",
        arch: "x64",
        stopListener: vi.fn(),
        startListener,
      });
      expect(result.upgraded).toBe(false);
      expect(result.error).toContain("curl: (56)");
      expect(startListener).toHaveBeenCalled();
      expect(isComposioUpgrading()).toBe(false);
      // Recover shared error state for later tests
      const { execFn: okFn } = createUpgradeFake({ startVersion: "0.2.33" });
      await ensureComposioCliAtVersion({
        fs: kNoBinaryFs,
        execFn: okFn,
        homedir: "/home/test",
        targetVersion: "0.2.33",
      });
    });
  });

  describe("ensureComposioListenFlag", () => {
    const createConfigFs = (initial) => {
      const files = new Map();
      if (initial !== undefined) {
        files.set("/home/test/.composio/config.json", JSON.stringify(initial));
      }
      return {
        files,
        fs: {
          readFileSync: (p) => {
            if (!files.has(String(p))) throw new Error("ENOENT");
            return files.get(String(p));
          },
          writeFileSync: (p, data) => files.set(String(p), String(data)),
          mkdirSync: () => {},
          existsSync: (p) => files.has(String(p)),
        },
      };
    };

    it("writes the flag preserving existing config fields", () => {
      const { fs, files } = createConfigFs({
        developer: { enabled: true },
        experimental_features: {},
        security: "auto",
      });
      expect(ensureComposioListenFlag({ fs, homedir: "/home/test" })).toBe(true);
      const written = JSON.parse(files.get("/home/test/.composio/config.json"));
      expect(written.experimental_features.listen).toBe(true);
      expect(written.developer).toEqual({ enabled: true });
      expect(written.security).toBe("auto");
    });

    it("is idempotent when the flag is already set", () => {
      const { fs } = createConfigFs({ experimental_features: { listen: true } });
      expect(ensureComposioListenFlag({ fs, homedir: "/home/test" })).toBe(false);
    });

    it("creates the config when missing", () => {
      const { fs, files } = createConfigFs();
      expect(ensureComposioListenFlag({ fs, homedir: "/home/test" })).toBe(true);
      const written = JSON.parse(files.get("/home/test/.composio/config.json"));
      expect(written.experimental_features.listen).toBe(true);
    });
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

  it("keeps the installing flag up until onComplete finishes", async () => {
    const { execFn } = createExecFake({ installSucceeds: true });
    let installingDuringComplete = null;
    const onComplete = vi.fn(async () => {
      installingDuringComplete = isComposioInstalling();
    });
    await ensureComposioCliInstalled({ fs: kNoBinaryFs, execFn, onComplete });
    // Status polls during the post-install refresh must still see
    // "installing", or the dashboard stops polling before the refreshed
    // state is cached.
    expect(installingDuringComplete).toBe(true);
    expect(isComposioInstalling()).toBe(false);
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
