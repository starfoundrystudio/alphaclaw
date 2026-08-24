const http = require("http");
const net = require("net");

const {
  createVaultProxyShim,
  isLoopbackHost,
} = require("../../lib/server/agent-vault/proxy-shim");

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

// Plaintext HTTP through a CONNECT tunnel — the exact shape OpenClaw's
// managed proxy produces for loopback plugin services (and the shape the
// vault MITM shreds).
const plaintextHttpViaConnect = (shimPort, targetHostPort, path) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(shimPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\n\r\n`,
      );
    });
    let phase = "connect";
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (phase === "connect" && buffer.includes("\r\n\r\n")) {
        if (!buffer.startsWith("HTTP/1.1 200")) {
          socket.destroy();
          return reject(new Error(`CONNECT refused: ${buffer.split("\r\n")[0]}`));
        }
        phase = "request";
        buffer = "";
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${targetHostPort}\r\nConnection: close\r\n\r\n`,
        );
      }
    });
    socket.on("close", () => resolve(buffer));
    socket.on("error", reject);
  });

describe("agent vault proxy shim", () => {
  let shim;
  let localService;
  let localPort;
  let fakeVault;
  let vaultSeen;

  beforeEach(async () => {
    // Local loopback service standing in for SearXNG / signal-cli.
    localService = http.createServer((req, res) => {
      if (req.url.startsWith("/sse")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.write("data: two\n\n"), 30);
        setTimeout(() => res.end("data: done\n\n"), 60);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    localPort = await listen(localService);

    // Fake vault upstream: records the CONNECT head it receives.
    vaultSeen = [];
    fakeVault = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        vaultSeen.push(chunk.toString());
        socket.end("HTTP/1.1 200 Connection Established\r\n\r\nUPSTREAM");
      });
    });
    const vaultPort = await new Promise((resolve) => {
      fakeVault.listen(0, "127.0.0.1", () => resolve(fakeVault.address().port));
    });

    shim = createVaultProxyShim({
      listenPort: 0,
      upstreamPort: vaultPort,
      logger: { log: () => {} },
    });
    // listenPort 0 needs the actual bound port back out for the tests.
    await shim.start();
  });

  afterEach(async () => {
    await shim.stop();
    localService.close();
    fakeVault.close();
  });

  const shimPort = () => shim.port();

  it("dials literal loopback targets locally, plaintext-in-CONNECT included", async () => {
    const response = await plaintextHttpViaConnect(
      shimPort(),
      `127.0.0.1:${localPort}`,
      "/search?q=test",
    );
    expect(response).toContain("200");
    expect(response).toContain('"ok":true');
    expect(vaultSeen).toHaveLength(0);
  });

  it("streams SSE progressively through a loopback tunnel", async () => {
    const chunks = [];
    const timestamps = [];
    await new Promise((resolve, reject) => {
      const socket = net.connect(shimPort(), "127.0.0.1", () => {
        socket.write(
          `CONNECT 127.0.0.1:${localPort} HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\n\r\n`,
        );
      });
      let connected = false;
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (!connected && text.includes("200 Connection Established")) {
          connected = true;
          socket.write(
            `GET /sse HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\nConnection: close\r\n\r\n`,
          );
          return;
        }
        chunks.push(text);
        timestamps.push(Date.now());
      });
      socket.on("close", resolve);
      socket.on("error", reject);
    });
    const joined = chunks.join("");
    expect(joined).toContain("data: one");
    expect(joined).toContain("data: done");
    // Progressive delivery: events arrived across time, not as one buffer.
    expect(timestamps[timestamps.length - 1] - timestamps[0]).toBeGreaterThan(20);
  });

  it("relays non-loopback CONNECTs verbatim to the vault, auth preserved", async () => {
    await new Promise((resolve, reject) => {
      const socket = net.connect(shimPort(), "127.0.0.1", () => {
        socket.write(
          "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\n",
        );
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("UPSTREAM")) {
          socket.destroy();
          resolve();
        }
      });
      socket.on("error", reject);
      socket.on("close", () => resolve());
    });
    expect(vaultSeen).toHaveLength(1);
    expect(vaultSeen[0]).toContain("CONNECT example.com:443 HTTP/1.1");
    expect(vaultSeen[0]).toContain("Proxy-Authorization: Basic c2VjcmV0");
  });

  it("serves absolute-form plain-http to loopback locally", async () => {
    const body = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: shimPort(),
            path: `http://127.0.0.1:${localPort}/direct`,
            headers: { Host: `127.0.0.1:${localPort}` },
          },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          },
        )
        .on("error", reject);
    });
    expect(JSON.parse(body)).toEqual({ ok: true, path: "/direct" });
  });

  it("classifies loopback hosts strictly by literal, no DNS", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.8.9.10")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("myhost.local")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});
