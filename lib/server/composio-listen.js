const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  composioStatePath,
  readComposioState,
  writeComposioState,
  setComposioGmailWatch,
  listGoogleWorkspaceAccounts,
} = require("./composio-state");
const { readGoogleState, resolveGoogleProvider } = require("./google-state");

const kGmailTriggerSlug = "GMAIL_NEW_GMAIL_MESSAGE";
const kRestartDelayMs = 5000;
const kMaxSnippetLength = 300;

// The listen verb only exists in CLI builds that print this phrase in help;
// the stable CLI falls back to generic help output for unknown commands.
const kListenSupportMarker = "Create a temporary subscription";

const composioBinDir = (homedir) => path.join(homedir, ".composio");

// With 2FA enabled on the Composio project, trigger creation requires the
// session's consumer user id; the CLI records it in its permissions cache.
const resolveConsumerUserId = ({ fs, homedir }) => {
  try {
    const cachePath = path.join(
      composioBinDir(homedir),
      "tool-permissions-cache.json",
    );
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const entries = parsed?.entries;
    if (!entries || typeof entries !== "object") return "";
    for (const entry of Object.values(entries)) {
      const userId = String(entry?.consumerUserId || "").trim();
      if (userId) return userId;
    }
    return "";
  } catch {
    return "";
  }
};

const buildListenArgs = ({ userId = "" } = {}) => {
  const args = ["listen", kGmailTriggerSlug];
  if (userId) {
    args.push("-p", JSON.stringify({ user_id: userId }));
  }
  // Print each event payload as a single JSON line on stdout.
  args.push("--stream", ".");
  return args;
};

// Events may arrive as the v3 envelope ({metadata:{trigger_slug}, data:{...}})
// or as a bare trigger payload depending on the stream path; accept both.
const normalizeComposioGmailEvent = (event = {}) => {
  if (!event || typeof event !== "object") return null;
  const slug = String(event?.metadata?.trigger_slug || "").trim().toUpperCase();
  if (slug && slug !== kGmailTriggerSlug) return null;
  const data =
    event?.data && typeof event.data === "object" ? event.data : event;
  const from = String(data.sender || data.from || "").trim();
  const subject = String(data.subject || "").trim();
  if (!from && !subject) return null;
  const preview =
    data.preview && typeof data.preview === "object" ? data.preview : {};
  const snippet = String(
    preview.snippet || preview.body || data.message_text || "",
  )
    .trim()
    .slice(0, kMaxSnippetLength);
  return {
    from: from || "unknown sender",
    subject: subject || "(no subject)",
    snippet,
    id: String(data.message_id || data.id || "").trim(),
    threadId: String(data.thread_id || "").trim(),
    timestamp: String(data.message_timestamp || event.timestamp || "").trim(),
  };
};

const createComposioListenService = ({
  fs,
  constants,
  composioCmd,
  ensureHookWiring,
  spawnFn = spawn,
  fetchFn = fetch,
  homedir = os.homedir(),
  now = Date.now,
}) => {
  const statePath = composioStatePath(constants.OPENCLAW_DIR);
  let child = null;
  let stopping = false;
  let restartTimer = null;

  const readState = () => readComposioState({ fs, statePath });
  const saveWatch = (watch) => {
    const { state } = setComposioGmailWatch({ state: readState(), watch });
    return writeComposioState({ fs, statePath, state });
  };

  const isProviderComposio = () => {
    try {
      const googleState = readGoogleState({
        fs,
        statePath: path.join(constants.OPENCLAW_DIR, "gogcli", "state.json"),
      });
      return resolveGoogleProvider({ state: googleState }).provider === "composio";
    } catch {
      return false;
    }
  };

  const checkListenSupport = async () => {
    const result = await composioCmd("listen --help", { quiet: true });
    return `${result.stdout}\n${result.stderr}`.includes(kListenSupportMarker);
  };

  const postEventToGmailHook = async (normalized) => {
    const token = String(process.env.WEBHOOK_TOKEN || "").trim();
    if (!token) throw new Error("WEBHOOK_TOKEN is not configured");
    const response = await fetchFn(
      `http://127.0.0.1:${constants.PORT}/hooks/gmail`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [
            {
              from: normalized.from,
              subject: normalized.subject,
              snippet: normalized.snippet,
              id: normalized.id,
              threadId: normalized.threadId,
              timestamp: normalized.timestamp,
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gmail hook delivery failed: HTTP ${response.status}`);
    }
  };

  const handleStdoutLine = async (line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed.startsWith("{")) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    const normalized = normalizeComposioGmailEvent(event);
    if (!normalized) return;
    try {
      await postEventToGmailHook(normalized);
      saveWatch({ lastEventAt: now(), lastError: "" });
    } catch (err) {
      console.error("[composio-listen] Event delivery failed:", err.message);
      saveWatch({ lastError: `delivery: ${err.message}` });
    }
  };

  const scheduleRestart = () => {
    if (restartTimer) return;
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      try {
        const state = readState();
        if (!state.gmailWatch.enabled) return;
        await startListener();
      } catch (err) {
        console.error("[composio-listen] Restart failed:", err.message);
      }
    }, kRestartDelayMs);
    restartTimer.unref?.();
  };

  const startListener = async () => {
    if (child?.pid) return { pid: child.pid, running: true };
    const userId = resolveConsumerUserId({ fs, homedir });
    const args = buildListenArgs({ userId });
    stopping = false;
    const spawned = spawnFn("composio", args, {
      env: {
        ...process.env,
        PATH: `${composioBinDir(homedir)}:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;

    let stdoutBuffer = "";
    spawned.stdout?.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleStdoutLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    let stderrTail = "";
    spawned.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-500);
    });

    spawned.on("exit", (code, signal) => {
      if (child === spawned) child = null;
      if (stopping) return;
      const reason = `listener exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
      console.error(`[composio-listen] ${reason}`);
      saveWatch({
        pid: null,
        lastError: `${reason}${stderrTail ? `: ${stderrTail.trim().slice(0, 200)}` : ""}`,
      });
      scheduleRestart();
    });

    saveWatch({ enabled: true, pid: spawned.pid || null, startedAt: now() });
    return { pid: spawned.pid || null, running: true };
  };

  const stopListener = async () => {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = child;
    child = null;
    if (current?.pid) {
      await new Promise((resolve) => {
        const timeoutHandle = setTimeout(() => {
          try {
            current.kill("SIGKILL");
          } catch {}
          resolve();
        }, 5000);
        current.once("exit", () => {
          clearTimeout(timeoutHandle);
          resolve();
        });
        try {
          current.kill("SIGTERM");
        } catch {
          clearTimeout(timeoutHandle);
          resolve();
        }
      });
    }
  };

  const enable = async () => {
    if (!isProviderComposio()) {
      throw new Error("Google provider is not composio");
    }
    const state = readState();
    if (!listGoogleWorkspaceAccounts(state).some((a) => a.toolkit.includes("gmail"))) {
      throw new Error("No active Gmail account is linked in Composio");
    }
    if (!(await checkListenSupport())) {
      throw new Error(
        "The installed Composio CLI does not support trigger subscriptions (`composio listen`). Upgrade the CLI and retry.",
      );
    }
    ensureHookWiring?.();
    const status = await startListener();
    return { ok: true, ...status };
  };

  const disable = async () => {
    await stopListener();
    saveWatch({ enabled: false, pid: null });
    return { ok: true };
  };

  const getStatus = () => {
    const watch = readState().gmailWatch;
    return {
      ...watch,
      running: Boolean(child?.pid),
      pid: child?.pid || watch.pid || null,
    };
  };

  // Restore the listener on boot when it was left enabled.
  const start = () => {
    setTimeout(async () => {
      try {
        const state = readState();
        if (!state.gmailWatch.enabled || !isProviderComposio()) return;
        if (!(await checkListenSupport())) {
          saveWatch({
            lastError:
              "Composio CLI does not support `listen`; email notifications paused",
          });
          return;
        }
        await startListener();
      } catch (err) {
        console.error("[composio-listen] Boot restore failed:", err.message);
      }
    }, 0);
  };

  const stop = async () => {
    await stopListener();
  };

  return {
    start,
    stop,
    enable,
    disable,
    getStatus,
    checkListenSupport,
  };
};

module.exports = {
  kGmailTriggerSlug,
  buildListenArgs,
  resolveConsumerUserId,
  normalizeComposioGmailEvent,
  createComposioListenService,
};
