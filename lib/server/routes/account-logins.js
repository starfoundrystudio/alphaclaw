const crypto = require("crypto");
const { spawn } = require("child_process");

const kClaudeCliProfileId = "anthropic:claude-cli";
const kMaxLoginOutputChars = 64 * 1024;
const kClaudeLoginTimeoutMs = 10 * 60 * 1000;
const kClaudeLoginTerminationGraceMs = 2 * 1000;
const kClaudeLoginRetentionMs = 10 * 60 * 1000;

const trimOutput = (value) => {
  const text = String(value || "");
  return text.length > kMaxLoginOutputChars
    ? text.slice(text.length - kMaxLoginOutputChars)
    : text;
};

const parseClaudeAuthStatus = (output) => {
  const text = String(output || "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        loggedIn: Boolean(parsed.loggedIn),
        email: String(parsed.email || "").trim(),
        loginMethod: String(parsed.authMethod || "").trim(),
        raw: text,
      };
    }
  } catch {}
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
  claudeBrokerService,
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
      await runShell(shellCmd, "claude auth status --json 2>&1 || true", {
        env,
        timeout: 15000,
        logStdout: false,
      }),
    );
  } catch (err) {
    statusText = [err?.stdout, err?.stderr].filter(Boolean).join("\n");
    authError = err.message || "Claude CLI auth status failed";
  }
  const parsedStatus = parseClaudeAuthStatus(statusText);
  const profile = authProfiles?.getClaudeCliProfile?.() || null;
  const broker =
    typeof claudeBrokerService?.status === "function"
      ? await claudeBrokerService.status()
      : null;
  return {
    ok: true,
    installed: true,
    binary,
    version,
    loggedIn: parsedStatus.loggedIn,
    email: parsedStatus.email || String(profile?.email || "").trim(),
    loginMethod:
      parsedStatus.loginMethod || String(profile?.loginMethod || "").trim(),
    statusText: parsedStatus.raw,
    configured: !!authProfiles?.hasClaudeCliProfile?.(),
    profileId: kClaudeCliProfileId,
    ...(broker ? { broker } : {}),
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
  claudeBrokerService,
  loginTimeoutMs = kClaudeLoginTimeoutMs,
  loginTerminationGraceMs = kClaudeLoginTerminationGraceMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  const delay = (milliseconds) =>
    new Promise((resolve) => {
      const timer = setTimeoutFn(resolve, Math.max(0, milliseconds));
      timer?.unref?.();
    });

  const scheduleRetentionCleanup = (operation) => {
    if (operation.retentionTimer) return;
    operation.retentionTimer = setTimeoutFn(() => {
      if (loginProcesses.get(operation.id) === operation) {
        loginProcesses.delete(operation.id);
      }
    }, kClaudeLoginRetentionMs);
    operation.retentionTimer?.unref?.();
  };

  const discardCancelledLogin = async (operation) => {
    if (operation.discardPromise) return operation.discardPromise;
    operation.discardPromise = Promise.resolve()
      .then(() => claudeBrokerService?.discardPendingLogin?.())
      .catch((error) => {
        operation.error =
          error?.message || "Failed to clean up the cancelled Claude login";
        operation.append?.(`\n${operation.error}\n`);
        throw error;
      });
    return operation.discardPromise;
  };

  const terminateLoginOperation = async (
    operation,
    { status = "cancelled", error = "Claude login was cancelled" } = {},
  ) => {
    if (!operation) {
      return { changed: false, status: "not_found" };
    }
    if (["cancelled", "timed_out"].includes(operation.status)) {
      return { changed: false, status: operation.status };
    }
    if (operation.status !== "running") {
      operation.status = status;
      operation.error = error;
      operation.append?.(`\n[${error}]\n`);
      await discardCancelledLogin(operation);
      scheduleRetentionCleanup(operation);
      return { changed: true, status: operation.status };
    }
    operation.status = status;
    operation.error = error;
    operation.append?.(`\n[${error}]\n`);
    if (operation.timeoutTimer) {
      clearTimeoutFn(operation.timeoutTimer);
      operation.timeoutTimer = null;
    }
    try {
      operation.child?.stdin?.end?.();
    } catch {}
    try {
      operation.child?.kill?.("SIGTERM");
    } catch {}

    const exited = await Promise.race([
      operation.exitPromise.then(() => true),
      delay(loginTerminationGraceMs).then(() => false),
    ]);
    if (!exited) {
      try {
        operation.child?.kill?.("SIGKILL");
      } catch {}
      await Promise.race([
        operation.exitPromise,
        delay(loginTerminationGraceMs),
      ]);
    }
    await discardCancelledLogin(operation);
    scheduleRetentionCleanup(operation);
    return { changed: true, status: operation.status };
  };

  app.get("/api/account-logins/claude-cli/status", async (_req, res) => {
    try {
      const status = await getClaudeCliStatus({
        shellCmd,
        gatewayEnv,
        authProfiles,
        claudeBrokerService,
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
      const existing = Array.from(loginProcesses.values()).find(
        (operation) => operation?.status === "running",
      );
      if (existing) {
        return res.json({ ok: true, id: existing.id, reused: true });
      }
      const id = crypto.randomBytes(12).toString("hex");
      const env = {
        ...process.env,
        ...(gatewayEnv?.() || {}),
        ALPHACLAW_CLAUDE_LOGIN_BYPASS: "1",
      };
      const operation = {
        id,
        output: "",
        status: "running",
        startedAt: Date.now(),
        exitCode: null,
        error: "",
      };
      operation.exitPromise = new Promise((resolve) => {
        operation.resolveExit = resolve;
      });
      const child = spawnFn("claude", ["auth", "login", "--claudeai"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      operation.child = child;
      loginProcesses.set(id, operation);
      const append = (chunk) => {
        operation.output = trimOutput(operation.output + String(chunk || ""));
      };
      operation.append = append;
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => {
        if (operation.status === "running") {
          operation.status = "error";
          operation.error = err.message || "Claude login failed to start";
          append(`\n${operation.error}\n`);
        }
        if (operation.timeoutTimer) {
          clearTimeoutFn(operation.timeoutTimer);
          operation.timeoutTimer = null;
        }
        operation.resolveExit?.();
        void discardCancelledLogin(operation).catch(() => {});
        scheduleRetentionCleanup(operation);
      });
      child.on("exit", (code, signal) => {
        if (operation.status === "running") {
          operation.status = code === 0 ? "complete" : "exited";
        }
        operation.exitCode = code;
        operation.signal = signal || "";
        append(`\n[claude auth login exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}]\n`);
        if (operation.timeoutTimer) {
          clearTimeoutFn(operation.timeoutTimer);
          operation.timeoutTimer = null;
        }
        operation.resolveExit?.();
        if (operation.status !== "complete") {
          void discardCancelledLogin(operation).catch(() => {});
        }
        scheduleRetentionCleanup(operation);
      });
      operation.timeoutTimer = setTimeoutFn(() => {
        void terminateLoginOperation(operation, {
          status: "timed_out",
          error: "Claude login timed out after 10 minutes",
        }).catch(() => {});
      }, loginTimeoutMs);
      operation.timeoutTimer?.unref?.();
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message || "Failed to start Claude CLI login",
      });
    }
  });

  app.post("/api/account-logins/claude-cli/login/:id/cancel", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const operation = loginProcesses.get(id);
    if (!operation) {
      return res
        .status(404)
        .json({ ok: false, error: "Claude login operation not found" });
    }
    try {
      const result = await terminateLoginOperation(operation);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Failed to cancel Claude login",
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
        claudeBrokerService,
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
      if (typeof claudeBrokerService?.adopt === "function") {
        await claudeBrokerService.adopt({
          email: status.email,
          loginMethod: status.loginMethod,
        });
      } else {
        authProfiles?.upsertClaudeCliProfile?.({
          email: status.email,
          loginMethod: status.loginMethod,
        });
      }
      const nextStatus = await getClaudeCliStatus({
        shellCmd,
        gatewayEnv,
        authProfiles,
        claudeBrokerService,
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

  app.post("/api/account-logins/claude-cli/disconnect", async (_req, res) => {
    try {
      if (typeof claudeBrokerService?.disconnect === "function") {
        const result = await claudeBrokerService.disconnect();
        const status = await getClaudeCliStatus({
          shellCmd,
          gatewayEnv,
          authProfiles,
          claudeBrokerService,
        });
        return res.status(result.ok ? 200 : 503).json({
          ...result,
          status: { ...status, configured: false, loggedIn: false },
        });
      }
      const changed = authProfiles?.removeClaudeCliProfile?.() || false;
      return res.json({ ok: true, changed });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || "Failed to disconnect Claude CLI",
      });
    }
  });
};

module.exports = {
  getClaudeCliStatus,
  parseClaudeAuthStatus,
  registerAccountLoginRoutes,
};
