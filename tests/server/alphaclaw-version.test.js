const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kAlphaclawRegistryUrl,
  kNpmPackageRoot,
  kOpenclawUpdateCopyTimeoutMs,
  kRootDir,
} = require("../../lib/server/constants");
const modulePath = require.resolve("../../lib/server/alphaclaw-version");
const originalExec = childProcess.exec;

const createFetchResponse = ({ ok = true, status = 200, body = {} } = {}) => ({
  ok,
  status,
  text: vi.fn(async () =>
    typeof body === "string" ? body : JSON.stringify(body),
  ),
});

const loadVersionModule = ({ execMock } = {}) => {
  if (execMock) childProcess.exec = execMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

const createService = ({
  env = {},
  readOpenclawVersion = () => "2026.4.1",
  fetchMock = vi.fn(),
  execMock = vi.fn(),
  fsImpl = fs,
} = {}) => {
  const { createAlphaclawVersionService } = loadVersionModule({ execMock });
  const service = createAlphaclawVersionService({
    env,
    readOpenclawVersion,
    fetchImpl: fetchMock,
    fsImpl,
  });
  return { service, fetchMock, execMock };
};

describe("server/alphaclaw-version", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
  });

  it("reads current version from package.json", () => {
    const { service } = createService();
    const version = service.readAlphaclawVersion();

    const expectedPkg = JSON.parse(
      fs.readFileSync(path.join(kNpmPackageRoot, "package.json"), "utf8"),
    );
    expect(version).toBe(expectedPkg.version);
  });

  it("returns local self-update status from npm", async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe(kAlphaclawRegistryUrl);
      return createFetchResponse({
        body: {
          "dist-tags": { latest: "99.0.0" },
        },
      });
    });
    const { service } = createService({
      env: {},
      readOpenclawVersion: () => "2026.4.10",
      fetchMock,
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const status = await service.getVersionStatus(false);

    expect(status).toEqual(
      expect.objectContaining({
        ok: true,
        currentVersion: expect.any(String),
        currentOpenclawVersion: "2026.4.10",
        latestVersion: "99.0.0",
        hasUpdate: true,
        updateStrategy: expect.objectContaining({
          action: "self-update",
          provider: "self-hosted",
        }),
      }),
    );
  });

  it("returns container instructions without attempting a registry lookup", async () => {
    const fetchMock = vi.fn();
    const { service } = createService({
      fetchMock,
      fsImpl: { ...fs, existsSync: vi.fn((target) => target === "/.dockerenv") },
    });

    const status = await service.getVersionStatus(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status).toEqual(
      expect.objectContaining({
        ok: true,
        latestVersion: null,
        latestOpenclawVersion: null,
        hasUpdate: false,
        updateStrategy: expect.objectContaining({
          provider: "container",
          action: "instructions",
          primaryActionLabel: "Done",
        }),
      }),
    );

    const result = await service.updateAlphaclaw();
    expect(result.status).toBe(409);
    expect(result.body.updateStrategy).toEqual(
      expect.objectContaining({
        provider: "container",
        action: "instructions",
      }),
    );
  });

  it("returns TeamYou support instructions for clawctl-managed deployments", async () => {
    const fetchMock = vi.fn(async () =>
      createFetchResponse({
        body: {
          "dist-tags": { latest: "99.0.0" },
        },
      }),
    );
    const { service } = createService({
      env: { ALPHACLAW_DEPLOYMENT_PROVIDER: "clawctl" },
      fetchMock,
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const status = await service.getVersionStatus(true);

    expect(status.updateStrategy).toEqual(
      expect.objectContaining({
        provider: "clawctl",
        label: "TeamYou",
        action: "instructions",
        description: "This AlphaClaw instance is managed by TeamYou.",
        steps: ["Contact TeamYou support to request an upgrade."],
        primaryActionLabel: "Done",
      }),
    );

    const result = await service.updateAlphaclaw();

    expect(result.status).toBe(409);
    expect(result.body.updateStrategy).toEqual(
      expect.objectContaining({
        provider: "clawctl",
        label: "TeamYou",
        action: "instructions",
        description: "This AlphaClaw instance is managed by TeamYou.",
        steps: ["Contact TeamYou support to request an upgrade."],
        primaryActionLabel: "Done",
      }),
    );
  });

  it("returns 409 while another self-update is in progress", async () => {
    const callbacks = [];
    const execMock = vi.fn().mockImplementation((cmd, opts, callback) => {
      callbacks.push(callback);
    });
    const fetchMock = vi.fn(async () =>
      createFetchResponse({
        body: {
          "dist-tags": { latest: "99.0.0" },
        },
      }),
    );
    const { service } = createService({
      fetchMock,
      execMock,
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const firstPromise = service.updateAlphaclaw();
    await new Promise((resolve) => setImmediate(resolve));

    const secondResult = await service.updateAlphaclaw();
    expect(secondResult.status).toBe(409);
    expect(secondResult.body).toEqual({
      ok: false,
      error: "AlphaClaw update already in progress",
    });

    callbacks[0](null, "installed", "");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    callbacks[1](null, "", "");
    await firstPromise;
  });

  it("returns successful self-update result with restarting flag", async () => {
    const execMock = vi.fn().mockImplementation((cmd, opts, callback) => {
      callback(null, "added 1 package", "");
    });
    const { service } = createService({
      execMock,
      fetchMock: vi.fn(),
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const result = await service.updateAlphaclaw();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.restarting).toBe(true);
    expect(result.body.previousVersion).toBeTruthy();
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      "npm install --omit=dev --prefer-online --package-lock=false",
      expect.objectContaining({
        cwd: expect.stringContaining(path.join(os.tmpdir(), "alphaclaw-update-")),
        env: expect.objectContaining({
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
        }),
        timeout: 180000,
      }),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^cp -af /),
      expect.objectContaining({ timeout: kOpenclawUpdateCopyTimeoutMs }),
      expect.any(Function),
    );
  });

  it("returns 500 when npm install fails", async () => {
    const execMock = vi.fn().mockImplementation((cmd, opts, callback) => {
      callback(
        new Error("npm ERR! network timeout"),
        "",
        "npm ERR! network timeout",
      );
    });
    const { service } = createService({
      execMock,
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const result = await service.updateAlphaclaw();

    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("npm ERR!");
  });

  it("writes update marker to kRootDir on successful self-update", async () => {
    const execMock = vi.fn().mockImplementation((cmd, opts, callback) => {
      callback(null, "added 1 package", "");
    });
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const { service } = createService({
      execMock,
      fsImpl: { ...fs, existsSync: vi.fn(() => false) },
    });

    const result = await service.updateAlphaclaw();

    expect(result.status).toBe(200);
    const markerPath = path.join(kRootDir, ".alphaclaw-update-pending");
    const markerCall = writeSpy.mock.calls.find(
      (call) => call[0] === markerPath,
    );
    expect(markerCall).toBeTruthy();
    const markerData = JSON.parse(markerCall[1]);
    expect(markerData).toHaveProperty("from");
    expect(markerData).toHaveProperty("ts");

    writeSpy.mockRestore();
  });
});
