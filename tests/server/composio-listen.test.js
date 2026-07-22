const { EventEmitter } = require("events");
const {
  kGmailTriggerSlug,
  buildListenArgs,
  resolveConsumerUserId,
  normalizeComposioGmailEvent,
  createComposioListenService,
} = require("../../lib/server/composio-listen");

const kConsumerUid = "consumer-af81f6d4-9e4b-403d-a25f-d6fbd0e8686e-ok_I5lXZaZfvajJ";

describe("server/composio-listen", () => {
  describe("buildListenArgs", () => {
    it("includes the user_id param when provided (2FA projects)", () => {
      expect(buildListenArgs({ userId: kConsumerUid })).toEqual([
        "listen",
        kGmailTriggerSlug,
        "-p",
        JSON.stringify({ user_id: kConsumerUid }),
        "--stream",
        ".",
      ]);
    });

    it("omits the param when no user id is known", () => {
      expect(buildListenArgs({})).toEqual([
        "listen",
        kGmailTriggerSlug,
        "--stream",
        ".",
      ]);
    });
  });

  describe("resolveConsumerUserId", () => {
    it("reads the consumer user id from the CLI permissions cache", () => {
      const fs = {
        readFileSync: () =>
          JSON.stringify({
            entries: {
              "ok_X:pr_Y:consumer-abc": {
                orgId: "ok_X",
                projectId: "pr_Y",
                consumerUserId: kConsumerUid,
              },
            },
          }),
      };
      expect(resolveConsumerUserId({ fs, homedir: "/home/test" })).toBe(
        kConsumerUid,
      );
    });

    it("returns empty string when the cache is missing", () => {
      const fs = {
        readFileSync: () => {
          throw new Error("ENOENT");
        },
      };
      expect(resolveConsumerUserId({ fs, homedir: "/home/test" })).toBe("");
    });
  });

  describe("normalizeComposioGmailEvent", () => {
    it("normalizes a v3 envelope with gmail payload", () => {
      const normalized = normalizeComposioGmailEvent({
        id: "msg_1",
        type: "composio.trigger.message",
        metadata: { trigger_slug: kGmailTriggerSlug, connected_account_id: "ca_1" },
        data: {
          sender: "alice@example.com",
          subject: "Hello",
          message_text: "Long body text here",
          message_id: "m1",
          thread_id: "t1",
          message_timestamp: "2026-07-22T00:00:00Z",
        },
        timestamp: "2026-07-22T00:00:01Z",
      });
      expect(normalized).toEqual({
        from: "alice@example.com",
        subject: "Hello",
        snippet: "Long body text here",
        id: "m1",
        threadId: "t1",
        timestamp: "2026-07-22T00:00:00Z",
      });
    });

    it("ignores events for other trigger slugs", () => {
      expect(
        normalizeComposioGmailEvent({
          metadata: { trigger_slug: "SLACK_RECEIVE_MESSAGE" },
          data: { sender: "x", subject: "y" },
        }),
      ).toBeNull();
    });

    it("accepts bare payloads without an envelope", () => {
      const normalized = normalizeComposioGmailEvent({
        sender: "bob@example.com",
        subject: "Bare",
        preview: { snippet: "short preview" },
      });
      expect(normalized).toMatchObject({
        from: "bob@example.com",
        subject: "Bare",
        snippet: "short preview",
      });
    });

    it("rejects non-gmail-shaped objects", () => {
      expect(normalizeComposioGmailEvent({ foo: "bar" })).toBeNull();
      expect(normalizeComposioGmailEvent(null)).toBeNull();
    });
  });

  describe("createComposioListenService", () => {
    const kOriginalWebhookToken = process.env.WEBHOOK_TOKEN;
    const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;

    beforeEach(() => {
      process.env.WEBHOOK_TOKEN = "hook-token";
      process.env.ALPHACLAW_GOOGLE_PROVIDER = "composio";
    });

    afterEach(() => {
      if (typeof kOriginalWebhookToken === "undefined") {
        delete process.env.WEBHOOK_TOKEN;
      } else {
        process.env.WEBHOOK_TOKEN = kOriginalWebhookToken;
      }
      if (typeof kOriginalProviderEnv === "undefined") {
        delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
      } else {
        process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
      }
    });

    const createHarness = ({
      listenSupported = true,
      accounts = [
        { id: "gmail_trick-stythe", toolkit: "gmail", status: "ACTIVE", active: true },
      ],
    } = {}) => {
      const files = new Map();
      files.set(
        "/openclaw/composio/state.json",
        JSON.stringify({
          version: 1,
          cliInstalled: true,
          loggedIn: true,
          accounts,
          gmailWatch: { enabled: false },
        }),
      );
      const fs = {
        existsSync: (p) => files.has(String(p)),
        readFileSync: (p) => {
          if (!files.has(String(p))) throw new Error("ENOENT");
          return files.get(String(p));
        },
        writeFileSync: (p, data) => files.set(String(p), String(data)),
        mkdirSync: () => {},
      };
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => child.emit("exit", 0, "SIGTERM"));
      const spawnFn = vi.fn(() => child);
      const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
      const composioCmd = vi.fn(async () => ({
        ok: true,
        stdout: listenSupported
          ? "listen — Create a temporary subscription for consumer-project events"
          : "generic help output",
        stderr: "",
      }));
      const ensureHookWiring = vi.fn();
      const service = createComposioListenService({
        fs,
        constants: { OPENCLAW_DIR: "/openclaw", PORT: 3000 },
        composioCmd,
        ensureHookWiring,
        spawnFn,
        fetchFn,
        homedir: "/home/test",
        now: () => 1784700000000,
      });
      return { service, files, child, spawnFn, fetchFn, composioCmd, ensureHookWiring };
    };

    it("enables the listener: hook wiring, spawn args, state persistence", async () => {
      const { service, child, spawnFn, ensureHookWiring, files } = createHarness();

      const result = await service.enable();

      expect(result.ok).toBe(true);
      expect(ensureHookWiring).toHaveBeenCalled();
      expect(spawnFn).toHaveBeenCalledWith(
        "composio",
        expect.arrayContaining(["listen", kGmailTriggerSlug, "--stream", "."]),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
      const state = JSON.parse(files.get("/openclaw/composio/state.json"));
      expect(state.gmailWatch.enabled).toBe(true);
      expect(state.gmailWatch.pid).toBe(child.pid);
      expect(service.getStatus().running).toBe(true);
    });

    it("delivers streamed events to the local gmail hook", async () => {
      const { service, child, fetchFn } = createHarness();
      await service.enable();

      const event = {
        metadata: { trigger_slug: kGmailTriggerSlug },
        data: { sender: "alice@example.com", subject: "Hi", message_text: "Body" },
      };
      child.stdout.emit("data", `${JSON.stringify(event)}\n`);
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchFn).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/hooks/gmail",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer hook-token",
          }),
        }),
      );
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.messages[0]).toMatchObject({
        from: "alice@example.com",
        subject: "Hi",
        snippet: "Body",
      });
    });

    it("ignores non-event stdout lines", async () => {
      const { service, child, fetchFn } = createHarness();
      await service.enable();

      child.stdout.emit(
        "data",
        "listening for events GMAIL_NEW_GMAIL_MESSAGE (tail at /tmp/x)\nnot json\n",
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("refuses to enable when the CLI lacks listen support", async () => {
      const { service } = createHarness({ listenSupported: false });

      await expect(service.enable()).rejects.toThrow(/does not support trigger/);
    });

    it("refuses to enable without a linked gmail account", async () => {
      const { service } = createHarness({ accounts: [] });

      await expect(service.enable()).rejects.toThrow(/No active Gmail account/);
    });

    it("disable stops the child and persists disabled state", async () => {
      const { service, child, files } = createHarness();
      await service.enable();

      await service.disable();

      expect(child.kill).toHaveBeenCalled();
      const state = JSON.parse(files.get("/openclaw/composio/state.json"));
      expect(state.gmailWatch.enabled).toBe(false);
      expect(service.getStatus().running).toBe(false);
    });

    it("records exit errors for unexpected listener death", async () => {
      const { service, child, files } = createHarness();
      await service.enable();

      child.stderr.emit("data", "TypeError: Object is not a constructor");
      child.emit("exit", 1, null);
      await new Promise((resolve) => setImmediate(resolve));

      const state = JSON.parse(files.get("/openclaw/composio/state.json"));
      expect(state.gmailWatch.lastError).toContain("listener exited");
      expect(state.gmailWatch.lastError).toContain("Object is not a constructor");
      expect(service.getStatus().running).toBe(false);
      // still enabled — a restart is pending
      expect(state.gmailWatch.enabled).toBe(true);
      await service.stop();
    });
  });
});
