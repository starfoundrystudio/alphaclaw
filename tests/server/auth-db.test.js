const fs = require("fs");
const os = require("os");
const path = require("path");

const { createLoginThrottle } = require("../../lib/server/login-throttle");
const { kLoginMaxAttempts } = require("../../lib/server/constants");

const loadAuthDb = () => {
  const modulePath = require.resolve("../../lib/server/db/auth");
  delete require.cache[modulePath];
  return require(modulePath);
};

let currentAuthDb = null;
let currentRootDir = "";

const createAuthDbContext = (prefix) => {
  currentRootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  currentAuthDb = loadAuthDb();
  const dbResult = currentAuthDb.initAuthDb({ rootDir: currentRootDir });
  return {
    ...currentAuthDb,
    ...dbResult,
    rootDir: currentRootDir,
  };
};

describe("server/auth-db", () => {
  afterEach(() => {
    if (currentAuthDb?.closeAuthDb) {
      currentAuthDb.closeAuthDb();
      currentAuthDb = null;
    }
    if (currentRootDir) {
      fs.rmSync(currentRootDir, { recursive: true, force: true });
      currentRootDir = "";
    }
  });

  it("initializes auth.db under root db directory", () => {
    const result = createAuthDbContext("auth-db-init-");

    expect(result.path).toBe(path.join(result.rootDir, "db", "auth.db"));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("persists login throttle failures across throttle instances", () => {
    const { createLoginThrottleStore } = createAuthDbContext("auth-db-throttle-");
    const firstThrottle = createLoginThrottle({
      store: createLoginThrottleStore(),
    });
    const now = 1_000;
    const firstState = firstThrottle.getOrCreateLoginAttemptState(
      "client-1",
      now,
    );

    for (let i = 0; i < kLoginMaxAttempts - 1; i += 1) {
      const result = firstThrottle.recordLoginFailure(firstState, now + i);
      expect(result.locked).toBe(false);
    }

    const secondThrottle = createLoginThrottle({
      store: createLoginThrottleStore(),
    });
    const secondState = secondThrottle.getOrCreateLoginAttemptState(
      "client-1",
      now + 100,
    );
    const lockResult = secondThrottle.recordLoginFailure(secondState, now + 100);

    expect(lockResult.locked).toBe(true);
  });

  it("stores the durable advanced Control UI acknowledgement audit trail", () => {
    const {
      insertAdvancedControlAcknowledgement,
      listAdvancedControlAcknowledgements,
    } = createAuthDbContext("auth-db-advanced-control-");

    const id = insertAdvancedControlAcknowledgement({
      userIdentity: "person@example.com",
      sessionId: "session-123",
      instanceId: "oc_inst_123",
      warningVersion: "teamyou.advanced-control-warning/v1",
      managedConfigRevision: "2026-09-22.1",
      clientIp: "100.64.0.5",
      acknowledgedAt: "2026-09-18T16:30:00.000Z",
    });

    expect(id).toBeGreaterThan(0);
    expect(listAdvancedControlAcknowledgements()).toEqual([
      {
        id,
        userIdentity: "person@example.com",
        sessionId: "session-123",
        instanceId: "oc_inst_123",
        warningVersion: "teamyou.advanced-control-warning/v1",
        managedConfigRevision: "2026-09-22.1",
        clientIp: "100.64.0.5",
        acknowledgedAt: "2026-09-18T16:30:00.000Z",
      },
    ]);
  });
});
