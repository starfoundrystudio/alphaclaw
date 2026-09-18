const { EventEmitter } = require("events");

const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");

const createSocket = () => ({
  write: vi.fn(),
  destroy: vi.fn(),
});

const createHarness = ({ authorized = true, acknowledged = true } = {}) => {
  const server = new EventEmitter();
  const proxy = { ws: vi.fn() };
  createWatchdogTerminalWsBridge({
    server,
    proxy,
    getGatewayUrl: () => "http://127.0.0.1:18789",
    isAuthorizedRequest: () => authorized,
    isAdvancedControlAuthorized: () => acknowledged,
    isRequestAllowedForSurface: () => true,
    watchdogTerminal: { createOrReuseSession: vi.fn() },
  });
  return { server, proxy };
};

describe("advanced Control UI websocket gate", () => {
  it("requires both Clawbridge auth and the signed acknowledgement", () => {
    const unauthenticated = createHarness({ authorized: false });
    const unauthenticatedSocket = createSocket();
    unauthenticated.server.emit(
      "upgrade",
      { url: "/openclaw", method: "GET", headers: { host: "test" } },
      unauthenticatedSocket,
      Buffer.alloc(0),
    );
    expect(unauthenticatedSocket.write).toHaveBeenCalledWith(
      expect.stringContaining("401 Unauthorized"),
    );
    expect(unauthenticated.proxy.ws).not.toHaveBeenCalled();

    const unacknowledged = createHarness({ acknowledged: false });
    const unacknowledgedSocket = createSocket();
    unacknowledged.server.emit(
      "upgrade",
      { url: "/openclaw", method: "GET", headers: { host: "test" } },
      unacknowledgedSocket,
      Buffer.alloc(0),
    );
    expect(unacknowledgedSocket.write).toHaveBeenCalledWith(
      expect.stringContaining("403 Forbidden"),
    );
    expect(unacknowledged.proxy.ws).not.toHaveBeenCalled();
  });

  it("allows only the acknowledged /openclaw namespace to reach Gateway websockets", () => {
    const allowed = createHarness();
    const allowedSocket = createSocket();
    const request = {
      url: "/openclaw?client=openclaw-control-ui",
      method: "GET",
      headers: { host: "test" },
    };
    const head = Buffer.alloc(0);
    allowed.server.emit("upgrade", request, allowedSocket, head);
    expect(allowed.proxy.ws).toHaveBeenCalledWith(
      request,
      allowedSocket,
      head,
      { target: "http://127.0.0.1:18789" },
    );

    const legacyRootSocket = createSocket();
    allowed.server.emit(
      "upgrade",
      { url: "/", method: "GET", headers: { host: "test" } },
      legacyRootSocket,
      Buffer.alloc(0),
    );
    expect(legacyRootSocket.write).toHaveBeenCalledWith(
      expect.stringContaining("404 Not Found"),
    );
    expect(allowed.proxy.ws).toHaveBeenCalledTimes(1);
  });
});
