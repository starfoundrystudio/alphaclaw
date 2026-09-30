const { EventEmitter } = require("events");
const http = require("http");
const { WebSocket } = require("ws");

const {
  attachWsHeartbeat,
  kWsHeartbeatIntervalMs,
} = require("../../lib/server/ws-heartbeat");
const {
  createOperationEventsService,
  kSseHeartbeatIntervalMs,
} = require("../../lib/server/operation-events");
const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");
const { createChatWsService } = require("../../lib/server/chat-ws");

const createFakeWs = () => {
  const ws = new EventEmitter();
  ws.ping = vi.fn();
  ws.terminate = vi.fn();
  return ws;
};

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });

const waitFor = (emitter, event) =>
  new Promise((resolve) => emitter.once(event, resolve));

describe("long-lived connection keepalives", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("attachWsHeartbeat", () => {
    it("pings every 30 s and keeps a socket that answers", () => {
      vi.useFakeTimers();
      const ws = createFakeWs();
      attachWsHeartbeat(ws);
      expect(kWsHeartbeatIntervalMs).toBe(30_000);

      vi.advanceTimersByTime(29_999);
      expect(ws.ping).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ws.ping).toHaveBeenCalledTimes(1);
      ws.emit("pong");
      vi.advanceTimersByTime(30_000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
      expect(ws.terminate).not.toHaveBeenCalled();
    });

    it("terminates a socket that missed the previous pong", () => {
      vi.useFakeTimers();
      const ws = createFakeWs();
      attachWsHeartbeat(ws);
      vi.advanceTimersByTime(60_000);
      expect(ws.ping).toHaveBeenCalledTimes(1);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(ws.ping).toHaveBeenCalledTimes(1);
    });

    it("stops pinging once the socket closes", () => {
      vi.useFakeTimers();
      const ws = createFakeWs();
      attachWsHeartbeat(ws);
      ws.emit("close");
      vi.advanceTimersByTime(120_000);
      expect(ws.ping).not.toHaveBeenCalled();
    });
  });

  describe("server sockets", () => {
    let server;
    let client;

    afterEach(async () => {
      client?.terminate();
      client = null;
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    });

    it("pings watchdog terminal sockets", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      server = http.createServer();
      createWatchdogTerminalWsBridge({
        server,
        proxy: { ws: vi.fn() },
        getGatewayUrl: () => "http://127.0.0.1:1",
        isAuthorizedRequest: () => true,
        isRequestAllowedForSurface: () => true,
        watchdogTerminal: {
          createOrReuseSession: () => ({ id: "session-1" }),
          subscribe: () => ({ ok: true, unsubscribe: () => {} }),
          writeInput: vi.fn(),
        },
      });
      const port = await listen(server);
      client = new WebSocket(`ws://127.0.0.1:${port}/api/watchdog/terminal/ws`);
      await waitFor(client, "open");
      const ping = waitFor(client, "ping");
      vi.advanceTimersByTime(30_000);
      await ping;
    });

    it("pings chat sockets", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const chat = createChatWsService({ fs: require("fs"), getGatewayPort: () => 1 });
      server = http.createServer();
      server.on("upgrade", (req, socket, head) => chat.handleUpgrade(req, socket, head));
      const port = await listen(server);
      client = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat`);
      await waitFor(client, "open");
      const ping = waitFor(client, "ping");
      vi.advanceTimersByTime(30_000);
      await ping;
    });
  });

  describe("operation event streams", () => {
    const createReq = () => {
      const req = new EventEmitter();
      return req;
    };
    const createRes = () => {
      const res = {
        status: vi.fn(() => res),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
      };
      return res;
    };

    it("writes a comment heartbeat every 15 s until the client leaves", () => {
      vi.useFakeTimers();
      expect(kSseHeartbeatIntervalMs).toBe(15_000);
      const service = createOperationEventsService();
      const { operationId } = service.createOperation({ type: "onboarding" });
      const req = createReq();
      const res = createRes();
      service.subscribe({ operationId, req, res });
      expect(res.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-cache, no-transform",
      );
      res.write.mockClear();

      vi.advanceTimersByTime(15_000);
      expect(res.write).toHaveBeenCalledWith(": keepalive\n\n");
      vi.advanceTimersByTime(15_000);
      expect(res.write).toHaveBeenCalledTimes(2);

      req.emit("close");
      vi.advanceTimersByTime(60_000);
      expect(res.write).toHaveBeenCalledTimes(2);
    });

    it("never sweeps an operation that is still running", () => {
      vi.useFakeTimers();
      const service = createOperationEventsService({ ttlMs: 100 });
      const { operationId } = service.createOperation({ type: "onboarding" });
      vi.advanceTimersByTime(10 * 60_000);
      expect(service.getOperation(operationId)).not.toBeNull();
      service.complete(operationId, { ok: true });
      vi.advanceTimersByTime(60_000);
      expect(service.getOperation(operationId)).toBeNull();
    });
  });
});
