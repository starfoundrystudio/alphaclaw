const net = require("net");
const path = require("path");
const {
  classifyRequestSurface,
} = require("../deployment-surface");

const kNotFoundBody = "Not found";
const kIngressSurfaceHeader = "x-alphaclaw-ingress-surface";
const kPageContentSecurityPolicy = [
  // Agent-authored pages may run scripts, but without allow-same-origin the
  // browser assigns an opaque origin that cannot access AlphaClaw cookies,
  // storage, or authenticated APIs on the surrounding setup origin.
  "sandbox allow-scripts",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const isPathWithin = (parentPath, candidatePath) =>
  candidatePath === parentPath ||
  candidatePath.startsWith(`${parentPath}${path.sep}`);

const normalizeIpAddress = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return normalized.slice("::ffff:".length);
  }
  return normalized;
};

const isRequestFromSecurityGateway = (req, env = process.env) => {
  const gatewayAddress = normalizeIpAddress(
    env.ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP,
  );
  if (!net.isIP(gatewayAddress)) return false;
  const remoteAddress = normalizeIpAddress(
    req?.socket?.remoteAddress || req?.connection?.remoteAddress,
  );
  return remoteAddress === gatewayAddress;
};

const createOpenclawPagesHandler = ({ fsModule, pagesDir }) => (req, res) => {
  // Do not grant CORS to the sandbox's opaque `null` origin: any website can
  // create one. Agent pages may use classic scripts and embedded data, but ES
  // modules and fetch need a future, genuinely separate page origin.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).type("text/plain").send("Method not allowed");
  }

  let pathname;
  try {
    pathname = decodeURIComponent(String(req.path || "/"));
  } catch {
    return res.status(400).type("text/plain").send("Invalid path");
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return res.status(400).type("text/plain").send("Invalid path");
  }

  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    return res.status(404).type("text/plain").send(kNotFoundBody);
  }

  try {
    const realPagesDir = fsModule.realpathSync(pagesDir);
    let candidatePath = path.resolve(realPagesDir, ...segments);
    if (!isPathWithin(realPagesDir, candidatePath)) {
      return res.status(404).type("text/plain").send(kNotFoundBody);
    }

    let stats = fsModule.statSync(candidatePath);
    if (stats.isDirectory()) {
      candidatePath = path.join(candidatePath, "index.html");
      stats = fsModule.statSync(candidatePath);
    }
    if (!stats.isFile()) {
      return res.status(404).type("text/plain").send(kNotFoundBody);
    }

    const realCandidatePath = fsModule.realpathSync(candidatePath);
    if (!isPathWithin(realPagesDir, realCandidatePath)) {
      return res.status(404).type("text/plain").send(kNotFoundBody);
    }

    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Security-Policy", kPageContentSecurityPolicy);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(realCandidatePath, (error) => {
      if (!error || res.headersSent) return;
      res.status(error.statusCode === 404 ? 404 : 500)
        .type("text/plain")
        .send(error.statusCode === 404 ? kNotFoundBody : "Unable to read page");
    });
  } catch {
    return res.status(404).type("text/plain").send(kNotFoundBody);
  }
};

const registerPageRoutes = ({
  app,
  requireAuth,
  isGatewayRunning,
  fsModule,
  openclawDir,
  env = process.env,
}) => {
  app.get("/health", async (req, res) => {
    const running = await isGatewayRunning();
    res.json({
      status: running ? "healthy" : "starting",
      gateway: running ? "running" : "starting",
    });
  });

  app.use(
    "/pages",
    (req, res, next) => {
      const surface = classifyRequestSurface(req, env);
      if (
        surface === "private" &&
        isRequestFromSecurityGateway(req, env) &&
        String(req.headers?.[kIngressSurfaceHeader] || "")
          .trim()
          .toLowerCase() === "private"
      ) {
        return next();
      }
      if (surface === "legacy") return requireAuth(req, res, next);
      if (surface === "private") return requireAuth(req, res, next);
      return res.status(404).type("text/plain").send(kNotFoundBody);
    },
    createOpenclawPagesHandler({
      fsModule,
      pagesDir: path.join(openclawDir, "pages"),
    }),
  );

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "public", "setup.html"));
  });

  app.get("/setup", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "public", "setup.html"));
  });
};

module.exports = {
  kIngressSurfaceHeader,
  kPageContentSecurityPolicy,
  createOpenclawPagesHandler,
  isRequestFromSecurityGateway,
  registerPageRoutes,
};
