const { execFile } = require("child_process");

const runGitCommand = (args, kRootResolved) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: 10000, cwd: kRootResolved },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({
            ok: false,
            error: String(
              stderr || stdout || error.message || "git command failed",
            ).trim(),
          });
        }
        return resolve({ ok: true, stdout: String(stdout || "") });
      },
    );
  });

const runGitCommandWithExitCode = (args, kRootResolved) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: 10000, cwd: kRootResolved },
      (error, stdout, stderr) => {
        const safeStdout = String(stdout || "");
        const safeStderr = String(stderr || "");
        if (!error) {
          return resolve({
            ok: true,
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode: 0,
          });
        }
        return resolve({
          ok: false,
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode: Number.isInteger(error.code) ? error.code : 1,
          error: String(error.message || "git command failed"),
        });
      },
    );
  });

module.exports = {
  runGitCommand,
  runGitCommandWithExitCode,
};
