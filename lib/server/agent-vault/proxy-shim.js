const http = require("http");
const net = require("net");

// Loopback-aware forward-proxy shim between the OpenClaw gateway and the
// Agent Vault proxy tunnel.
//
// OpenClaw's managed-proxy mode routes every in-process fetch through the
// configured proxy, including requests to services on the workload's own
// loopback (SearXNG, signal-cli, and any future plugin-run local service).
// The vault proxy terminates on the security gateway, where "127.0.0.1"
// means the wrong machine — and its MITM shreds plaintext CONNECT tunnels —
// so those requests can never succeed. The shim closes the whole class
// centrally: literal-loopback destinations are dialed locally and byte-piped
// (works for TLS, plaintext, SSE, and websockets alike); everything else is
// relayed verbatim to the vault tunnel, credential injection and MITM
// untouched. The shim holds no secrets: it relays the client's own
// Proxy-Authorization upstream and never logs headers.
//
// Only literal loopback names/addresses are dialed locally (no DNS
// resolution is performed to decide), mirroring the NO_PROXY entries the
// vault runtime env already advertises.

const kShimHost = "127.0.0.1";

const isLoopbackHost = (host) => {
  const normalized = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  if (normalized === "localhost") return true;
  if (normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  return false;
};

const splitHostPort = (value, defaultPort) => {
  const raw = String(value || "").trim();
  const bracketMatch = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: Number(bracketMatch[2] || defaultPort),
    };
  }
  const idx = raw.lastIndexOf(":");
  if (idx > -1 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) };
  }
  return { host: raw, port: defaultPort };
};

const pipeBoth = (a, b) => {
  a.pipe(b);
  b.pipe(a);
  const destroyBoth = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", destroyBoth);
  b.on("error", destroyBoth);
  a.on("close", destroyBoth);
  b.on("close", destroyBoth);
};

const rebuildConnectHead = (req) => {
  const lines = [`CONNECT ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
};

const createVaultProxyShim = ({
  listenPort,
  upstreamHost = "127.0.0.1",
  upstreamPort,
  logger = console,
}) => {
  if (listenPort === undefined || !upstreamPort) {
    throw new Error("Vault proxy shim requires listenPort and upstreamPort");
  }

  const server = http.createServer((req, res) => {
    // Absolute-form plain-HTTP proxying (GET http://host/path).
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("proxy shim: absolute-form URL required");
      return;
    }
    const upstreamIsLocal = isLoopbackHost(target.hostname);
    const options = upstreamIsLocal
      ? {
          host: target.hostname.replace(/^\[|\]$/g, ""),
          port: Number(target.port || 80),
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: { ...req.headers },
        }
      : {
          host: upstreamHost,
          port: upstreamPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers },
        };
    if (upstreamIsLocal) {
      delete options.headers["proxy-authorization"];
      delete options.headers["proxy-connection"];
    }
    const outbound = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    outbound.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(outbound);
  });

  server.on("connect", (req, clientSocket, head) => {
    const { host, port } = splitHostPort(req.url, 443);
    if (isLoopbackHost(host)) {
      const local = net.connect(port, host.replace(/^\[|\]$/g, ""), () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) local.write(head);
        pipeBoth(clientSocket, local);
      });
      local.on("error", () => {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
      return;
    }
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      upstream.write(rebuildConnectHead(req));
      if (head && head.length) upstream.write(head);
      pipeBoth(clientSocket, upstream);
    });
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  let started = false;
  return {
    start: () =>
      new Promise((resolve, reject) => {
        if (started) return resolve();
        server.once("error", reject);
        server.listen(listenPort, kShimHost, () => {
          started = true;
          server.removeListener("error", reject);
          logger.log(
            `[alphaclaw] Agent Vault proxy shim listening on ${kShimHost}:${server.address().port} (loopback direct, upstream ${upstreamHost}:${upstreamPort})`,
          );
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        if (!started) return resolve();
        started = false;
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    isStarted: () => started,
    port: () => (started ? server.address().port : null),
  };
};

module.exports = { createVaultProxyShim, isLoopbackHost };
