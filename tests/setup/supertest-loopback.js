// supertest's request(app) listens on port 0 on all interfaces (dual-stack ::)
// but always connects to 127.0.0.1:<port>. On macOS the kernel can hand that
// dual-stack listener a port another process already holds on 127.0.0.1 (for
// example Tailscale's LocalAPI), and connections to 127.0.0.1:<port> then go
// to the more specific 127.0.0.1 listener instead of the test app, producing
// impossible responses such as a 401 from an app with no auth.
//
// Bind the ephemeral test server to 127.0.0.1 itself, so the kernel only hands
// out a port that is free on that exact address, and connect to the address
// the server reports.
const { Server: TlsServer } = require("tls");
const { Test } = require("supertest");

const kPatched = Symbol.for("alphaclaw.tests.supertestLoopback");
const kLoopbackHost = "127.0.0.1";

if (!Test.prototype[kPatched]) {
  const pendingListens = new WeakMap();
  // Servers a pending Test will listen on (and close afterward), mirroring
  // supertest, where only the Test that started the listener closes it.
  const claimedServers = new WeakSet();

  const listenOnLoopback = (server) => {
    if (server.listening) return Promise.resolve();
    if (!pendingListens.has(server)) {
      pendingListens.set(
        server,
        new Promise((resolve, reject) => {
          const onError = (err) => {
            pendingListens.delete(server);
            reject(err);
          };
          server.once("error", onError);
          server.listen(0, kLoopbackHost, () => {
            server.off("error", onError);
            pendingListens.delete(server);
            resolve();
          });
        }),
      );
    }
    return pendingListens.get(server);
  };

  const originalServerAddress = Test.prototype.serverAddress;
  const originalEnd = Test.prototype.end;

  Test.prototype.serverAddress = function serverAddress(app, path) {
    if (app.address()) return originalServerAddress.call(this, app, path);
    // Listening on a specific host is asynchronous; finish it in end().
    const ownsServer = !claimedServers.has(app);
    claimedServers.add(app);
    this._loopbackListen = { app, path, ownsServer };
    return `http://${kLoopbackHost}:0${path}`;
  };

  Test.prototype.end = function end(fn) {
    const pending = this._loopbackListen;
    if (!pending) return originalEnd.call(this, fn);
    this._loopbackListen = null;
    listenOnLoopback(pending.app).then(
      () => {
        if (pending.ownsServer) claimedServers.delete(pending.app);
        const { address, port } = pending.app.address();
        const protocol = pending.app instanceof TlsServer ? "https" : "http";
        if (pending.ownsServer) this._server = pending.app;
        this.url = `${protocol}://${address}:${port}${pending.path}`;
        originalEnd.call(this, fn);
      },
      (err) => {
        if (pending.ownsServer) claimedServers.delete(pending.app);
        if (typeof fn === "function") fn(err);
        else this.emit("error", err);
      },
    );
    return this;
  };

  Test.prototype[kPatched] = true;
}
