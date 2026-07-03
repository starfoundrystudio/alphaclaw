const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureManagedGatewayDevicePreapproval,
  kManagedGatewayDeviceScopes,
} = require("../../lib/server/managed-gateway-device");

const makeTempOpenclawDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-device-"));

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const createApprovingBootstrapModule = ({ token = "operator-token", paired = [] } = {}) => {
  const approveDevicePairing = vi.fn(async (requestId, options, baseDir) => {
    const pending = readJson(path.join(baseDir, "devices", "pending.json"));
    const request = pending[requestId];
    return {
      status: "approved",
      requestId,
      device: {
        deviceId: request.deviceId,
        publicKey: request.publicKey,
        displayName: request.displayName,
        clientId: request.clientId,
        clientMode: request.clientMode,
        role: "operator",
        roles: ["operator"],
        scopes: request.scopes,
        approvedScopes: request.scopes,
        tokens: {
          operator: {
            token,
            role: "operator",
            scopes: request.scopes,
            createdAtMs: 1773506886016,
          },
        },
        createdAtMs: 1773506886016,
        approvedAtMs: 1773506886016,
      },
    };
  });
  return {
    approveDevicePairing,
    listDevicePairing: vi.fn(async () => ({ pending: [], paired })),
  };
};

describe("server/managed-gateway-device", () => {
  let tempDirs = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("creates and approves a managed gateway device with the non-admin scope baseline", async () => {
    const openclawDir = makeTempOpenclawDir();
    tempDirs.push(openclawDir);
    const bootstrapModule = createApprovingBootstrapModule();

    const result = await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => bootstrapModule,
      nowMs: 1773506886016,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        changed: true,
        reason: "approved",
      }),
    );
    const identity = readJson(path.join(openclawDir, "identity", "device.json"));
    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");

    const pending = readJson(path.join(openclawDir, "devices", "pending.json"));
    const request = pending[bootstrapModule.approveDevicePairing.mock.calls[0][0]];
    expect(request).toEqual(
      expect.objectContaining({
        deviceId: identity.deviceId,
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        roles: ["operator"],
        scopes: kManagedGatewayDeviceScopes,
        silent: true,
        isRepair: false,
      }),
    );
    expect(request.scopes).not.toContain("operator.admin");
    expect(bootstrapModule.approveDevicePairing).toHaveBeenCalledWith(
      request.requestId,
      {
        callerScopes: expect.arrayContaining(["operator.admin", "operator.pairing"]),
      },
      openclawDir,
    );

    const auth = readJson(path.join(openclawDir, "identity", "device-auth.json"));
    expect(auth).toEqual({
      version: 1,
      deviceId: identity.deviceId,
      tokens: {
        operator: {
          token: "operator-token",
          role: "operator",
          scopes: kManagedGatewayDeviceScopes,
          updatedAtMs: 1773506886016,
        },
      },
    });
  });

  it("does nothing when the paired record and cached operator token already match", async () => {
    const openclawDir = makeTempOpenclawDir();
    tempDirs.push(openclawDir);
    const firstBootstrapModule = createApprovingBootstrapModule({ token: "first-token" });
    await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => firstBootstrapModule,
      nowMs: 1773506886016,
    });
    const identity = readJson(path.join(openclawDir, "identity", "device.json"));
    const firstRequestId = firstBootstrapModule.approveDevicePairing.mock.calls[0][0];
    const firstRequest = readJson(path.join(openclawDir, "devices", "pending.json"))[
      firstRequestId
    ];
    const pairedDevice = {
      deviceId: identity.deviceId,
      publicKey: firstRequest.publicKey,
      tokens: {
        operator: {
          token: "first-token",
          role: "operator",
          scopes: kManagedGatewayDeviceScopes,
        },
      },
    };
    const healthyBootstrapModule = createApprovingBootstrapModule({ paired: [pairedDevice] });

    const result = await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => healthyBootstrapModule,
      nowMs: 1773506887016,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        changed: false,
        reason: "already-approved",
        deviceId: identity.deviceId,
      }),
    );
    expect(healthyBootstrapModule.approveDevicePairing).not.toHaveBeenCalled();
  });

  it("repairs a paired device when the cached operator token is missing", async () => {
    const openclawDir = makeTempOpenclawDir();
    tempDirs.push(openclawDir);
    const firstBootstrapModule = createApprovingBootstrapModule({ token: "stale-token" });
    await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => firstBootstrapModule,
      nowMs: 1773506886016,
    });
    fs.rmSync(path.join(openclawDir, "identity", "device-auth.json"));

    const identity = readJson(path.join(openclawDir, "identity", "device.json"));
    const firstRequestId = firstBootstrapModule.approveDevicePairing.mock.calls[0][0];
    const firstRequest = readJson(path.join(openclawDir, "devices", "pending.json"))[
      firstRequestId
    ];
    const repairBootstrapModule = createApprovingBootstrapModule({
      token: "repaired-token",
      paired: [
        {
          deviceId: identity.deviceId,
          publicKey: firstRequest.publicKey,
          tokens: {
            operator: {
              token: "stale-token",
              role: "operator",
              scopes: kManagedGatewayDeviceScopes,
            },
          },
        },
      ],
    });

    const result = await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => repairBootstrapModule,
      nowMs: 1773506888016,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        changed: true,
        reason: "repaired",
      }),
    );
    const repairRequestId = repairBootstrapModule.approveDevicePairing.mock.calls[0][0];
    const repairRequest = readJson(path.join(openclawDir, "devices", "pending.json"))[
      repairRequestId
    ];
    expect(repairRequest.isRepair).toBe(true);
    expect(readJson(path.join(openclawDir, "identity", "device-auth.json")).tokens.operator).toEqual(
      {
        token: "repaired-token",
        role: "operator",
        scopes: kManagedGatewayDeviceScopes,
        updatedAtMs: 1773506888016,
      },
    );
  });

  it("returns a visible failure without throwing when OpenClaw rejects the approval", async () => {
    const openclawDir = makeTempOpenclawDir();
    tempDirs.push(openclawDir);
    const bootstrapModule = {
      listDevicePairing: vi.fn(async () => ({ pending: [], paired: [] })),
      approveDevicePairing: vi.fn(async () => ({
        status: "forbidden",
        reason: "caller-missing-scope",
        scope: "operator.approvals",
      })),
    };

    const result = await ensureManagedGatewayDevicePreapproval({
      openclawDir,
      loadBootstrapModule: async () => bootstrapModule,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        changed: true,
        reason: "approval-failed",
        error: "caller-missing-scope: operator.approvals",
      }),
    );
    expect(readJson(path.join(openclawDir, "devices", "pending.json"))).toEqual({});
  });
});
