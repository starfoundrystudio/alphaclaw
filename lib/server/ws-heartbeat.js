// Server-side WebSocket keepalive. Proxies on the ingress path (Cloudflare
// closes idle WebSockets after roughly 100 s) drop quiet sockets, so every
// browser-facing socket gets a ping on a fixed interval. Browsers answer
// pings with pongs automatically; a socket that has not answered the
// previous ping by the next tick is terminated so its handlers clean up.
const kWsHeartbeatIntervalMs = 30_000;

const attachWsHeartbeat = (ws, { intervalMs = kWsHeartbeatIntervalMs } = {}) => {
  if (!ws || typeof ws.ping !== "function") return () => {};
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  ws.on?.("pong", onPong);
  const timer = setInterval(() => {
    if (!alive) {
      stop();
      try {
        ws.terminate?.();
      } catch {}
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {}
  }, intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    ws.off?.("pong", onPong);
  };
  ws.once?.("close", stop);
  return stop;
};

module.exports = {
  attachWsHeartbeat,
  kWsHeartbeatIntervalMs,
};
