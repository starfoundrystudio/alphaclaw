const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");

const { createChatWsService } = require("../../lib/server/chat-ws");

const waitForListening = (server) =>
  new Promise((resolve) => {
    server.once("listening", resolve);
  });

const closeWsServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe("server/chat-ws", () => {
  let originalGatewayToken;
  let tempDir;
  let gatewayServer;
  let gatewaySocket;

  beforeEach(() => {
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-chat-ws-"));
  });

  afterEach(async () => {
    if (gatewaySocket && gatewaySocket.readyState === 1) {
      gatewaySocket.close();
    }
    if (gatewayServer) {
      await closeWsServer(gatewayServer);
      gatewayServer = null;
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("connects as the direct-local backend client that preserves operator scopes", async () => {
    const captured = {
      connectParams: null,
      headers: null,
      historyParams: null,
    };
    gatewayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForListening(gatewayServer);

    gatewayServer.on("connection", (socket, request) => {
      gatewaySocket = socket;
      captured.headers = request.headers;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
      socket.on("message", (rawData) => {
        const frame = JSON.parse(String(rawData || ""));
        if (frame.method === "connect") {
          captured.connectParams = frame.params;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok" },
            }),
          );
          return;
        }
        if (frame.method === "chat.history") {
          captured.historyParams = frame.params;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { messages: [] },
            }),
          );
        }
      });
    });

    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "bridge-token";

    const service = createChatWsService({
      fs,
      openclawDir: tempDir,
      getGatewayPort: () => gatewayServer.address().port,
    });

    const history = await service.fetchHistory("agent:main:main");

    expect(history).toEqual({ messages: [], rawHistory: { messages: [] } });
    expect(captured.headers.origin).toBeUndefined();
    expect(captured.connectParams).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        mode: "backend",
      },
      role: "operator",
      auth: { token: "bridge-token" },
    });
    expect(captured.connectParams.scopes).toEqual(
      expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
    );
    expect(captured.historyParams).toEqual({
      sessionKey: "agent:main:main",
      limit: 200,
    });
  });

  describe("agent event routing", () => {
    const kSessionKey = "agent:main:main";
    let httpServer;
    let browserSocket;

    afterEach(async () => {
      if (browserSocket && browserSocket.readyState === 1) {
        browserSocket.close();
      }
      browserSocket = null;
      if (httpServer) {
        await new Promise((resolve) => httpServer.close(() => resolve()));
        httpServer = null;
      }
    });

    const agentEvent = (payload) =>
      JSON.stringify({ type: "event", event: "agent", payload });

    const assistantText = (runId, text) => ({
      runId,
      sessionKey: kSessionKey,
      stream: "assistant",
      data: { text },
    });

    const lifecycleEnd = (runId) => ({
      runId,
      sessionKey: kSessionKey,
      stream: "lifecycle",
      data: { phase: "end" },
    });

    /**
     * Boots the bridge with a scripted fake gateway and a browser client
     * connected through handleUpgrade. `onChatSend(socket, frame)` decides
     * how the gateway answers chat.send (and may emit events first).
     */
    const startBridge = async ({ onChatSend }) => {
      gatewayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await waitForListening(gatewayServer);
      gatewayServer.on("connection", (socket) => {
        gatewaySocket = socket;
        socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
        socket.on("message", (rawData) => {
          const frame = JSON.parse(String(rawData || ""));
          if (frame.method === "connect") {
            socket.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { type: "hello-ok" },
              }),
            );
            return;
          }
          if (frame.method === "chat.send") {
            onChatSend(socket, frame);
          }
        });
      });

      fs.writeFileSync(
        path.join(tempDir, "openclaw.json"),
        JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }),
      );
      process.env.OPENCLAW_GATEWAY_TOKEN = "bridge-token";

      const service = createChatWsService({
        fs,
        openclawDir: tempDir,
        getGatewayPort: () => gatewayServer.address().port,
      });

      httpServer = http.createServer();
      httpServer.on("upgrade", (request, socket, head) => {
        service.handleUpgrade(request, socket, head);
      });
      await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

      browserSocket = new WebSocket(
        `ws://127.0.0.1:${httpServer.address().port}/`,
      );
      const received = [];
      const waiters = [];
      browserSocket.on("message", (rawData) => {
        const message = JSON.parse(String(rawData || ""));
        received.push(message);
        for (const waiter of waiters.splice(0)) waiter();
      });
      await new Promise((resolve) => browserSocket.once("open", resolve));

      const waitForMessage = (predicate) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for browser message")),
            5000,
          );
          const check = () => {
            const match = received.find(predicate);
            if (!match) {
              waiters.push(check);
              return;
            }
            clearTimeout(timer);
            resolve(match);
          };
          check();
        });

      const sendChat = (content) =>
        browserSocket.send(
          JSON.stringify({ type: "message", sessionKey: kSessionKey, content }),
        );

      return { received, waitForMessage, sendChat };
    };

    it("ignores a concurrent side run instead of hijacking the user's stream", async () => {
      // Reproduces the active-memory recall race: a second run in the same
      // session streams its "NONE" sentinel and ends while the user's run is
      // still streaming. The side run's output must not render, and its end
      // must not tear down the real run's delivery.
      const { received, waitForMessage, sendChat } = await startBridge({
        onChatSend: (socket, frame) => {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: "run-real" },
            }),
          );
        },
      });

      sendChat("Great, thank you!");
      await waitForMessage((m) => m.type === "started");

      gatewaySocket.send(agentEvent(assistantText("run-memory", "NONE")));
      gatewaySocket.send(agentEvent(lifecycleEnd("run-memory")));
      gatewaySocket.send(
        agentEvent(assistantText("run-real", "You're welcome, Bill.")),
      );
      gatewaySocket.send(agentEvent(lifecycleEnd("run-real")));

      await waitForMessage((m) => m.type === "done");

      const chunks = received.filter((m) => m.type === "chunk");
      expect(chunks.map((m) => m.content)).toEqual(["You're welcome, Bill."]);
      const doneMessages = received.filter((m) => m.type === "done");
      expect(doneMessages).toHaveLength(1);
      expect(received.indexOf(doneMessages[0])).toBeGreaterThan(
        received.indexOf(chunks[0]),
      );
    });

    it("buffers early events for the run later claimed by chat.send", async () => {
      // Agent events can outrun the chat.send response; they carry the run's
      // id before the bridge knows it. They must flush once the response
      // claims the run.
      const { received, waitForMessage, sendChat } = await startBridge({
        onChatSend: (socket, frame) => {
          socket.send(agentEvent(assistantText("run-early", "Hello")));
          socket.send(agentEvent(lifecycleEnd("run-early")));
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: "run-early" },
            }),
          );
        },
      });

      sendChat("Hi there");
      await waitForMessage((m) => m.type === "done");

      const chunks = received.filter((m) => m.type === "chunk");
      expect(chunks.map((m) => m.content)).toEqual(["Hello"]);
    });

    it("still delivers runId-less events for the active run via session matching", async () => {
      const { received, waitForMessage, sendChat } = await startBridge({
        onChatSend: (socket, frame) => {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: "run-real" },
            }),
          );
        },
      });

      sendChat("Hello?");
      await waitForMessage((m) => m.type === "started");

      gatewaySocket.send(
        agentEvent({
          sessionKey: kSessionKey,
          stream: "assistant",
          data: { text: "Hi" },
        }),
      );
      gatewaySocket.send(agentEvent(lifecycleEnd("run-real")));

      await waitForMessage((m) => m.type === "done");

      const chunks = received.filter((m) => m.type === "chunk");
      expect(chunks.map((m) => m.content)).toEqual(["Hi"]);
    });
  });
});
