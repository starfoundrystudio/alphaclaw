const { resolveRealGitPath } = require("../../lib/cli/git-runtime");

describe("cli/git runtime helpers", () => {
  it("resolves a real git path while skipping the installed shim", () => {
    const resolvedPath = resolveRealGitPath({
      shimPath: "/usr/local/bin/git",
      execSyncImpl: () => ["/usr/local/bin/git", "/bin/git"].join("\n"),
      fsModule: {
        constants: { X_OK: 1 },
        accessSync(targetPath) {
          if (targetPath !== "/bin/git") {
            throw new Error("not executable");
          }
        },
      },
    });

    expect(resolvedPath).toBe("/bin/git");
  });

  it("prefers the explicit hinted path when it is executable", () => {
    const resolvedPath = resolveRealGitPath({
      shimPath: "/usr/local/bin/git",
      hintedPath: "/custom/git",
      execSyncImpl: () => "",
      fsModule: {
        constants: { X_OK: 1 },
        accessSync(targetPath) {
          if (targetPath !== "/custom/git") {
            throw new Error("not executable");
          }
        },
      },
    });

    expect(resolvedPath).toBe("/custom/git");
  });
});
