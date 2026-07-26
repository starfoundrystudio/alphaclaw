const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const {
  createPublicIngressGuard,
} = require("../../lib/server/deployment-surface");
const {
  kIngressSurfaceHeader,
  kPageContentSecurityPolicy,
  registerPageRoutes,
} = require("../../lib/server/routes/pages");

const kStrictEnv = {
  ALPHACLAW_SETUP_URL: "https://alpha.tail123.ts.net",
  ALPHACLAW_PUBLIC_BASE_URL: "https://alpha.tail123.ts.net:8443",
  ALPHACLAW_GATEWAY_SETUP_HOST: "gateway.internal",
  ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP: "127.0.0.1",
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-pages-"));
  const openclawDir = path.join(root, ".openclaw");
  const pagesDir = path.join(openclawDir, "pages");
  fs.mkdirSync(path.join(pagesDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(pagesDir, "hello.html"), "<h1>Hello</h1>");
  fs.writeFileSync(path.join(pagesDir, "app.js"), "export const ok = true;");
  fs.writeFileSync(path.join(pagesDir, "data.json"), '{"ok":true}');
  fs.writeFileSync(
    path.join(pagesDir, "docs", "index.html"),
    "<h1>Docs</h1>",
  );
  fs.writeFileSync(path.join(pagesDir, ".secret"), "do not serve");
  return { root, openclawDir, pagesDir };
};

const createApp = ({
  openclawDir,
  env = kStrictEnv,
  requireAuth = (_req, res) =>
    res.status(401).type("text/plain").send("Unauthorized"),
}) => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createPublicIngressGuard({ env }));
  registerPageRoutes({
    app,
    requireAuth,
    isGatewayRunning: async () => true,
    fsModule: fs,
    openclawDir,
    env,
  });
  return app;
};

const privateHeaders = {
  "x-forwarded-host": "alpha.tail123.ts.net",
  "x-forwarded-proto": "https",
  [kIngressSurfaceHeader]: "private",
};

describe("server/routes/pages", () => {
  it("serves regular files and directory indexes on the private surface", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);

    const fileResponse = await request(app)
      .get("/pages/hello.html")
      .set(privateHeaders);
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.text).toBe("<h1>Hello</h1>");
    expect(fileResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(fileResponse.headers["content-security-policy"]).toBe(
      kPageContentSecurityPolicy,
    );
    expect(fileResponse.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts",
    );
    expect(fileResponse.headers["content-security-policy"]).not.toContain(
      "allow-same-origin",
    );

    const indexResponse = await request(app)
      .get("/pages/docs/")
      .set(privateHeaders);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.text).toBe("<h1>Docs</h1>");

    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("requires setup authentication when strict private routing is unavailable", async () => {
    const fixture = createFixture();
    const requireAuth = vi.fn((_req, res) =>
      res.status(401).type("text/plain").send("Unauthorized"),
    );
    const app = createApp({
      ...fixture,
      env: {
        ALPHACLAW_SETUP_URL: "https://legacy.example.com",
      },
      requireAuth,
    });

    const response = await request(app)
      .get("/pages/hello.html")
      .set({
        "x-forwarded-host": "legacy.example.com",
        "x-forwarded-proto": "https",
      });

    expect(response.status).toBe(401);
    expect(requireAuth).toHaveBeenCalledOnce();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("does not trust private-origin forwarded headers from another source address", async () => {
    const fixture = createFixture();
    const requireAuth = vi.fn((_req, res) =>
      res.status(401).type("text/plain").send("Unauthorized"),
    );
    const app = createApp({
      ...fixture,
      env: {
        ...kStrictEnv,
        ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP: "10.0.0.2",
      },
      requireAuth,
    });

    const response = await request(app)
      .get("/pages/hello.html")
      .set(privateHeaders);

    expect(response.status).toBe(401);
    expect(requireAuth).toHaveBeenCalledOnce();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("does not grant CORS access to opaque sandbox origins", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);

    const response = await request(app)
      .get("/pages/data.json")
      .set(privateHeaders)
      .set("Origin", "null");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("requires auth when the trusted gateway labels a request as public", async () => {
    const fixture = createFixture();
    const requireAuth = vi.fn((_req, res) =>
      res.status(401).type("text/plain").send("Unauthorized"),
    );
    const app = createApp({ ...fixture, requireAuth });

    const response = await request(app)
      .get("/pages/hello.html")
      .set({
        ...privateHeaders,
        [kIngressSurfaceHeader]: "public",
      });

    expect(response.status).toBe(401);
    expect(requireAuth).toHaveBeenCalledOnce();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("does not expose pages through the public Funnel surface", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);

    const response = await request(app)
      .get("/pages/hello.html")
      .set({
        "x-forwarded-host": "alpha.tail123.ts.net:8443",
        "x-forwarded-proto": "https",
      });

    expect(response.status).toBe(404);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("rejects dotfiles and symlinks that escape the pages root", async () => {
    const fixture = createFixture();
    const outsideFile = path.join(fixture.root, "outside.txt");
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, path.join(fixture.pagesDir, "outside-link"));
    const app = createApp(fixture);

    const dotfileResponse = await request(app)
      .get("/pages/.secret")
      .set(privateHeaders);
    const symlinkResponse = await request(app)
      .get("/pages/outside-link")
      .set(privateHeaders);

    expect(dotfileResponse.status).toBe(404);
    expect(symlinkResponse.status).toBe(404);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("allows only GET and HEAD methods", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);

    const headResponse = await request(app)
      .head("/pages/hello.html")
      .set(privateHeaders);
    const postResponse = await request(app)
      .post("/pages/hello.html")
      .set(privateHeaders);

    expect(headResponse.status).toBe(200);
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.allow).toBe("GET, HEAD");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
});
