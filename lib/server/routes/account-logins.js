const crypto = require("crypto");
const { spawn } = require("child_process");

const kClaudeCliProfileId = "anthropic:claude-cli";
const kMaxLoginOutputChars = 64 * 1024;

const trimOutput = (value) => {
  const text = String(value || "");
  return text.length > kMaxLoginOutputChars
    ? text.slice(text.length - kMaxLoginOutputChars)
    : text;
};

const parseClaudeAuthStatus = (output) => {
  const text = String(output || "").trim();
  const loggedIn =
    /login method:/i.test(text) ||
    /email:/i.test(text) ||
    /organization:/i.test(text);
  const emailMatch = text.match(/^Email:\s*(.+)$/im);
  const loginMethodMatch = text.match(/^Login method:\s*(.+)$/im);
  return {
    loggedIn,
    email: emailMatch ? emailMatch[1].trim() : "",
    loginMethod: loginMethodMatch ? loginMethodMatch[1].trim() : "",
    raw: text,
  };
};

const runShell = async (shellCmd, command, options = {}) => {
  if (typeof shellCmd !== "function") {
    throw new Error("Shell execution is unavailable");
  }
  return shellCmd(command, options);
};

const getClaudeCliStatus = async ({
  shellCmd,
  gatewayEnv = () => ({}),
  authProfiles,
} = {}) => {
  const env = gatewayEnv?.() || {};
  let binary = "";
  let version = "";
  let statusText = "";
  let authError = "";
  try {
    binary = String(
      await runShell(shellCmd, "command -v claude", { env, timeout: 10000 }),
    ).trim();
  } catch (err) {
    return {
      ok: true,
      installed: false,
      loggedIn: false,
      configured: !!authProfiles?.hasClaudeCliProfile?.(),
      profileId: kClaudeCliProfileId,
      error: err.message || "Claude CLI was not found",
    };
  }
  try {
    version = String(
      await runShell(shellCmd, "claude --version", { env, timeout: 10000 }),
    ).trim();
  } catch {}
  try {
    statusText = String(
      await runShell(shellCmd, "claude auth status --text", {
        env,
        timeout: 15000,
      }),
    );
  } catch (err) {
    statusText = [err?.stdout, err?.stderr].filter(Boolean).join("\n");
    authError = err.message || "Claude CLI auth status failed";
  }
  const parsedStatus = parseClaudeAuthStatus(statusText);
  return {
    ok: true,
    installed: true,
    binary,
    version,
    loggedIn: parsedStatus.loggedIn,
    email: parsedStatus.email,
    loginMethod: parsedStatus.loginMethod,
    statusText: parsedStatus.raw,
    configured: !!authProfiles?.hasClaudeCliProfile?.(),
    profileId: kClaudeCliProfileId,
    ...(authError && !parsedStatus.loggedIn ? { error: authError } : {}),
  };
};

const registerAccountLoginRoutes = ({
  app,
  authProfiles,
  shellCmd,
  gatewayEnv = () => ({}),
  loginProcesses = new Map(),
  spawnFn = spawn,
}) => {
  app.get("/api/account-logins/claude-cli/status", async (_req, res) => {
    try {
      const status = await getClaudeCliStatus({
        shellCmd,
        gatewayEnv,
        authProfiles,
      });
      res.json(status);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message || "Failed to check Claude CLI status",
      });
    }
  });

  app.post("/api/account-logins/claude-cli/login/start", (_req, res) => {
    try {
      const id = crypto.randomBytes(12).toString("hex");
      const env = { ...process.env, ...(gatewayEnv?.() || {}) };
      const operation = {
        id,
        output: "",
        status: "running",
        startedAt: Date.now(),
        exitCode: null,
        error: "",
      };
      const child = spawnFn("claude", ["auth", "login", "--claudeai"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      operation.child = child;
      loginProcesses.set(id, operation);
      const append = (chunk) => {
        operation.output = trimOutput(operation.output + String(chunk || ""));
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => {
        operation.status = "error";
        operation.error = err.message || "Claude login failed to start";
        append(`\n${operation.error}\n`);
      });
      child.on("exit", (code, signal) => {
        operation.status = code === 0 ? "complete" : "exited";
        operation.exitCode = code;
        operation.signal = signal || "";
        append(`\n[claude auth login exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}]\n`);
      });
      const cleanupTimer = setTimeout(() => {
        const current = loginProcesses.get(id);
        if (current?.status !== "running") {
          loginProcesses.delete(id);
        }
      }, 10 * 60 * 1000);
      cleanupTimer.unref?.();
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message || "Failed to start Claude CLI login",
      });
    }
  });

  app.post("/api/account-logins/claude-cli/login/:id/input", (req, res) => {
    const id = String(req.params.id || "").trim();
    const input = String(req.body?.input || "").trim();
    const operation = loginProcesses.get(id);
    if (!operation) {
      res.status(404).json({ ok: false, error: "Claude login operation not found" });
      return;
    }
    if (!input) {
      res.status(400).json({ ok: false, error: "Claude login code is required" });
      return;
    }
    if (operation.status !== "running") {
      res.status(409).json({ ok: false, error: "Claude login is not running" });
      return;
    }
    const stdin = operation.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      res.status(409).json({
        ok: false,
        error: "Claude login is not accepting input",
      });
      return;
    }
    stdin.write(`${input}\n`, (err) => {
      if (err) {
        res.status(500).json({
          ok: false,
          error: err.message || "Failed to send Claude login code",
        });
        return;
      }
      res.json({ ok: true });
    });
  });

  app.get("/api/account-logins/claude-cli/login/:id/events", (req, res) => {
    const id = String(req.params.id || "").trim();
    const operation = loginProcesses.get(id);
    if (!operation) {
      res.status(404).json({ ok: false, error: "Claude login operation not found" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    const write = (eventName = "phase") => {
      res.write(`event: ${eventName}\n`);
      res.write(
        `data: ${JSON.stringify({
          id,
          status: operation.status,
          output: operation.output,
          exitCode: operation.exitCode,
          error: operation.error,
        })}\n\n`,
      );
    };
    let intervalId = null;
    const writeCurrent = () => {
      const eventName =
        operation.status === "running"
          ? "phase"
          : operation.status === "error"
            ? "error"
            : "done";
      write(eventName);
      if (operation.status !== "running") {
        if (intervalId) clearInterval(intervalId);
        res.end();
      }
    };
    writeCurrent();
    if (operation.status === "running") {
      intervalId = setInterval(writeCurrent, 1000);
    }
    req.on("close", () => {
      if (intervalId) clearInterval(intervalId);
    });
  });

  app.post("/api/account-logins/claude-cli/adopt", async (_req, res) => {
    try {
      const status = await getClaudeCliStatus({
        shellCmd,
        gatewayEnv,
        authProfiles,
      });
      if (!status.installed) {
        return res.status(400).json({
          ok: false,
          error: "Claude CLI is not installed or not on PATH",
          status,
        });
      }
      if (!status.loggedIn) {
        return res.status(400).json({
          ok: false,
          error: "Run Claude CLI login before adopting Claude CLI reuse",
          status,
        });
      }
      authProfiles?.upsertClaudeCliProfile?.();
      const nextStatus = await getClaudeCliStatus({
        shellCmd,
        gatewayEnv,
        authProfiles,
      });
      return res.json({
        ok: true,
        changed: true,
        status: { ...nextStatus, configured: true },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || "Failed to adopt Claude CLI",
      });
    }
  });
};

module.exports = {
  getClaudeCliStatus,
  parseClaudeAuthStatus,
  registerAccountLoginRoutes,
};
