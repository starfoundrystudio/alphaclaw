const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  buildTeamYouEntryUrl,
  normalizeClawbridgeReturnTo,
  parseSsoPublicKeys,
  readTeamYouSsoConfig,
  verifyClawbridgeClaim,
} = require("../../lib/server/auth/teamyou-sso");
const {
  deriveSessionSigningKey,
  ensureSessionSecret,
} = require("../../lib/server/auth/session-key");

const kInstanceId = "inst_test123";
const kKid = "teamyou-clawbridge-v1";
const kDashboard = "https://gw-test.tail123.ts.net";
const kBootstrap = "https://acme.openclaw.teamyou.ai";
const kEntryUrl = `https://www.teamyou.com/openclaw/clawbridge/${kInstanceId}`;

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const kPublicX = publicKey.export({ format: "jwk" }).x;
const other = crypto.generateKeyPairSync("ed25519");

const buildEnv = (overrides = {}) => ({
  OPENCLAW_INSTANCE_ID: kInstanceId,
  TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS: `${kKid}:${kPublicX}`,
  TEAMYOU_CLAWBRIDGE_ENTRY_URL: kEntryUrl,
  ALPHACLAW_SETUP_URL: kDashboard,
  ALPHACLAW_BOOTSTRAP_URL: kBootstrap,
  ...overrides,
});

const nowSec = () => Math.floor(Date.now() / 1000);

const signClaim = (
  overrides = {},
  { key = privateKey, header = { alg: "EdDSA", typ: "JWT", kid: kKid } } = {},
) => {
  const iat = nowSec();
  const payload = {
    v: 1,
    purpose: "clawbridge_owner_session",
    instance_id: kInstanceId,
    owner_clerk_user_id: "user_2abcDEF",
    email: "owner@example.com",
    aud: kDashboard,
    return_to: "/",
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 300,
    ...overrides,
  };
  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) delete payload[field];
  }
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = crypto
    .sign(null, Buffer.from(signingInput), key)
    .toString("base64url");
  return { token: `${signingInput}.${signature}`, payload };
};

const verify = (token, { env = buildEnv(), origin = kDashboard } = {}) =>
  verifyClawbridgeClaim({
    claim: token,
    config: readTeamYouSsoConfig(env),
    requestOrigin: origin,
    env,
  });

describe("server/auth/teamyou-sso", () => {
  describe("config", () => {
    it("is enabled only with keys, a matching entry URL and an instance id", () => {
      expect(readTeamYouSsoConfig(buildEnv()).enabled).toBe(true);
      expect(
        readTeamYouSsoConfig(buildEnv({ TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS: "" }))
          .enabled,
      ).toBe(false);
      expect(
        readTeamYouSsoConfig(
          buildEnv({
            TEAMYOU_CLAWBRIDGE_ENTRY_URL:
              "https://www.teamyou.com/openclaw/clawbridge/inst_other",
          }),
        ).enabled,
      ).toBe(false);
      expect(
        readTeamYouSsoConfig(
          buildEnv({
            TEAMYOU_CLAWBRIDGE_ENTRY_URL: `http://www.teamyou.com/openclaw/clawbridge/${kInstanceId}`,
          }),
        ).enabled,
      ).toBe(false);
      expect(readTeamYouSsoConfig({}).enabled).toBe(false);
    });

    it("parses several keys and skips malformed entries", () => {
      const otherX = other.publicKey.export({ format: "jwk" }).x;
      const keys = parseSsoPublicKeys(
        `${kKid}:${kPublicX}, bad entry ,teamyou-clawbridge-v2:${otherX},v3:short`,
      );
      expect([...keys.keys()]).toEqual([kKid, "teamyou-clawbridge-v2"]);
    });

    it("builds entry links with only allowlisted return targets", () => {
      const config = readTeamYouSsoConfig(buildEnv());
      expect(buildTeamYouEntryUrl(config, "/")).toBe(kEntryUrl);
      expect(buildTeamYouEntryUrl(config, "/#/models")).toBe(
        `${kEntryUrl}?return_to=%2F%23%2Fmodels`,
      );
      expect(buildTeamYouEntryUrl(config, "https://evil.example")).toBe(
        kEntryUrl,
      );
    });
  });

  // Produced by TeamYou's signClawbridgeOwnerClaim with a test-only key
  // (teamyou lib/services/clawbridge-sso-service.test.ts asserts the same
  // token), pinning both sides to one wire format.
  it("verifies the cross-repo TeamYou test vector", () => {
    const vectorEnv = {
      OPENCLAW_INSTANCE_ID: "inst_vector01",
      TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS:
        "teamyou-clawbridge-v1:WeeArEHcknCuO8eKv7LNQQRXS7KcIyPidbJgGzSlK94",
      TEAMYOU_CLAWBRIDGE_ENTRY_URL:
        "https://www.teamyou.com/openclaw/clawbridge/inst_vector01",
      ALPHACLAW_SETUP_URL: "https://gw-vector.tail000.ts.net",
    };
    const token =
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6InRlYW15b3UtY2xhd2JyaWRnZS12MSJ9.eyJ2IjoxLCJwdXJwb3NlIjoiY2xhd2JyaWRnZV9vd25lcl9zZXNzaW9uIiwiaW5zdGFuY2VfaWQiOiJpbnN0X3ZlY3RvcjAxIiwib3duZXJfY2xlcmtfdXNlcl9pZCI6InVzZXJfdmVjdG9yMDEiLCJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9ndy12ZWN0b3IudGFpbDAwMC50cy5uZXQiLCJyZXR1cm5fdG8iOiIvIy9tb2RlbHMiLCJqdGkiOiI2ZjFjMmIzYS00ZDVlLTRmNjAtOGE3Yi05YzBkMWUyZjNhNGIiLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6MTc5MDAwMDMwMH0.XBctczUj9-jZd6OznxLuwqnaTrEmDqaDmSr3s-Ul5CDOX0HqIpTpIggdzn17L3umXBL-9Ci6pcPIdGpuvBh8Ag";
    expect(
      verifyClawbridgeClaim({
        claim: token,
        config: readTeamYouSsoConfig(vectorEnv),
        requestOrigin: "https://gw-vector.tail000.ts.net",
        env: vectorEnv,
        nowMs: 1790000000 * 1000,
      }),
    ).toMatchObject({
      ok: true,
      returnTo: "/#/models",
      identity: { sub: "user_vector01", email: "owner@example.com" },
    });
  });

  describe("return_to allowlist", () => {
    it.each([
      ["/", "/"],
      ["/#/general", "/#/general"],
      ["/#/credentials", "/#/credentials"],
      ["/openclaw/chat?session=main", "/openclaw/chat?session=main"],
      ["/#/unknown", ""],
      ["/#/models/extra", ""],
      ["//evil.example", ""],
      ["https://evil.example/", ""],
      ["/openclaw/chat?session=other", ""],
      ["\\\\evil", ""],
      ["", ""],
    ])("normalizes %s", (input, expected) => {
      expect(normalizeClawbridgeReturnTo(input)).toBe(expected);
    });
  });

  describe("verifyClawbridgeClaim", () => {
    it("accepts a valid dashboard claim and returns the owner identity", () => {
      const { token, payload } = signClaim({ return_to: "/#/models" });
      const result = verify(token);
      expect(result).toMatchObject({
        ok: true,
        jti: payload.jti,
        returnTo: "/#/models",
        identity: {
          method: "teamyou",
          sub: "user_2abcDEF",
          email: "owner@example.com",
        },
      });
    });

    it("rejects a claim signed by another key", () => {
      const { token } = signClaim({}, { key: other.privateKey });
      expect(verify(token)).toEqual({ ok: false, code: "invalid" });
    });

    it("rejects unknown kids and unexpected header fields", () => {
      const unknownKid = signClaim(
        {},
        { header: { alg: "EdDSA", typ: "JWT", kid: "teamyou-agent-vault-v1" } },
      ).token;
      const extraHeader = signClaim(
        {},
        { header: { alg: "EdDSA", typ: "JWT", kid: kKid, x5u: "https://x" } },
      ).token;
      expect(verify(unknownKid).code).toBe("invalid");
      expect(verify(extraHeader).code).toBe("invalid");
    });

    it("rejects a tampered payload", () => {
      const { token } = signClaim();
      const [header, , signature] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({ ...signClaim().payload, email: "attacker@example.com" }),
      ).toString("base64url");
      expect(verify(`${header}.${forged}.${signature}`).code).toBe("invalid");
    });

    it("rejects missing and extra payload fields", () => {
      expect(verify(signClaim({ email: undefined }).token).code).toBe("invalid");
      expect(verify(signClaim({ extra: true }).token).code).toBe("invalid");
    });

    it("rejects the Agent Vault claim purpose", () => {
      const { token } = signClaim({ purpose: "agent_vault_owner_session" });
      expect(verify(token).code).toBe("invalid");
    });

    it("rejects a claim for another instance", () => {
      const { token } = signClaim({ instance_id: "inst_other" });
      expect(verify(token).code).toBe("wrong_instance");
    });

    it("rejects a claim whose audience is not the request origin", () => {
      const { token } = signClaim();
      expect(
        verify(token, { origin: "https://gw-test.tail123.ts.net:8443" }).code,
      ).toBe("wrong_address");
      const bootstrapClaim = signClaim({ aud: kBootstrap }).token;
      expect(verify(bootstrapClaim, { origin: kDashboard }).code).toBe(
        "wrong_address",
      );
    });

    it("accepts the setup site only until the dashboard URL is set", () => {
      const bootstrapClaim = () => signClaim({ aud: kBootstrap }).token;
      const duringSetup = buildEnv({ ALPHACLAW_SETUP_URL: "" });
      expect(
        verify(bootstrapClaim(), { env: duringSetup, origin: kBootstrap }).ok,
      ).toBe(true);
      expect(
        verify(bootstrapClaim(), { env: buildEnv(), origin: kBootstrap }).code,
      ).toBe("wrong_address");
    });

    it("rejects an audience with a path or trailing slash", () => {
      const { token } = signClaim({ aud: `${kDashboard}/` });
      expect(verify(token).code).toBe("wrong_address");
    });

    it("enforces expiry, issue time and lifetime", () => {
      const now = nowSec();
      expect(
        verify(signClaim({ iat: now - 600, exp: now - 300 }).token).code,
      ).toBe("expired");
      expect(
        verify(signClaim({ iat: now + 300, exp: now + 600 }).token).code,
      ).toBe("invalid");
      expect(
        verify(signClaim({ iat: now, exp: now + 3600 }).token).code,
      ).toBe("invalid");
      expect(
        verify(signClaim({ iat: now - 330, exp: now - 30 }).token).ok,
      ).toBe(true);
    });

    it("rejects a disallowed return target and a non-UUID jti", () => {
      expect(
        verify(signClaim({ return_to: "https://evil.example" }).token).code,
      ).toBe("invalid");
      expect(verify(signClaim({ jti: "not-a-uuid" }).token).code).toBe(
        "invalid",
      );
    });

    it("rejects garbage without throwing", () => {
      for (const value of ["", "a.b", "a.b.c", "x".repeat(5000), null]) {
        expect(verify(value).ok).toBe(false);
      }
    });
  });

  describe("session key", () => {
    it("keeps the password as the key when there is no session secret", () => {
      expect(
        deriveSessionSigningKey({ sessionSecret: "", setupPassword: "pw" }),
      ).toBe("pw");
    });

    it("binds the password into the derived key", () => {
      const secret = crypto.randomBytes(32).toString("base64url");
      const withPassword = deriveSessionSigningKey({
        sessionSecret: secret,
        setupPassword: "pw",
      });
      expect(withPassword).not.toBe(
        deriveSessionSigningKey({ sessionSecret: secret, setupPassword: "" }),
      );
      expect(withPassword).not.toBe("pw");
    });

    it("generates and persists a secret only when TeamYou sign-in is on", () => {
      const writes = [];
      const env = {};
      expect(
        ensureSessionSecret({
          env,
          ssoEnabled: false,
          readEnvFile: () => [],
          writeEnvFile: (vars) => writes.push(vars),
        }),
      ).toBe("");
      expect(writes).toHaveLength(0);

      const secret = ensureSessionSecret({
        env,
        ssoEnabled: true,
        readEnvFile: () => [{ key: "EXISTING", value: "1" }],
        writeEnvFile: (vars) => writes.push(vars),
      });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(env.ALPHACLAW_SESSION_SECRET).toBe(secret);
      expect(writes[0]).toEqual([
        { key: "EXISTING", value: "1" },
        { key: "ALPHACLAW_SESSION_SECRET", value: secret },
      ]);
      expect(
        ensureSessionSecret({ env, ssoEnabled: true, writeEnvFile: () => {} }),
      ).toBe(secret);
    });

    it("keeps running with an in-memory secret when .env cannot be written", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const env = {};
      const secret = ensureSessionSecret({
        env,
        ssoEnabled: true,
        readEnvFile: () => [],
        writeEnvFile: () => {
          throw new Error("EROFS");
        },
      });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(env.ALPHACLAW_SESSION_SECRET).toBe(secret);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe("claim replay store", () => {
    let rootDir;
    let authDb;

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-sso-db-"));
      authDb = require("../../lib/server/db/auth");
      authDb.initAuthDb({ rootDir });
    });

    afterEach(() => {
      authDb.closeAuthDb();
      fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("accepts a jti once and prunes expired rows", () => {
      const store = authDb.createSsoClaimStore();
      const jti = crypto.randomUUID();
      expect(store.consume({ jti, expiresAt: 1000 })).toBe(true);
      expect(store.consume({ jti, expiresAt: 1000 })).toBe(false);
      store.prune(2000);
      expect(store.consume({ jti, expiresAt: 3000 })).toBe(true);
    });
  });
});

describe("server/routes/auth TeamYou sign-in", () => {
  const createThrottle = () => ({
    getClientKey: vi.fn(() => "client-key"),
    getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
    evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
    recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
    recordLoginSuccess: vi.fn(),
    cleanupLoginAttemptStates: vi.fn(),
  });

  const createClaimStore = () => {
    const used = new Set();
    return {
      consume: vi.fn(({ jti }) => {
        if (used.has(jti)) return false;
        used.add(jti);
        return true;
      }),
      prune: vi.fn(),
    };
  };

  const createApp = ({ env = buildEnv(), password = "" } = {}) => {
    const { registerAuthRoutes } = require("../../lib/server/routes/auth");
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    const throttle = createThrottle();
    const claimStore = createClaimStore();
    const routeEnv = { ...env, SETUP_PASSWORD: password };
    registerAuthRoutes({
      app,
      loginThrottle: throttle,
      sessionSigningKey: deriveSessionSigningKey({
        sessionSecret: crypto.randomBytes(32).toString("base64url"),
        setupPassword: password,
      }),
      ssoClaimStore: claimStore,
      env: routeEnv,
    });
    app.get("/api/protected", (_req, res) => res.json({ ok: true }));
    return { app, throttle, claimStore };
  };

  const fromDashboard = (req) =>
    req
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "gw-test.tail123.ts.net");

  it("signs the owner in, burns the claim and lands on the target", async () => {
    const { app, throttle } = createApp();
    const { token } = signClaim({ return_to: "/#/models" });

    const res = await fromDashboard(
      request(app).get(`/auth/teamyou?claim=${token}`),
    );

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/#/models");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    const cookie = res.headers["set-cookie"].join(";");
    expect(cookie).toContain("setup_token=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(throttle.recordLoginSuccess).toHaveBeenCalled();

    const sessionCookie = res.headers["set-cookie"][0].split(";")[0];
    const status = await request(app)
      .get("/api/auth/status")
      .set("Cookie", sessionCookie);
    expect(status.body).toEqual({
      authEnabled: true,
      methods: { password: false, teamyou: { entryUrl: kEntryUrl } },
      identity: { method: "teamyou", email: "owner@example.com" },
    });
    const protectedRes = await request(app)
      .get("/api/protected")
      .set("Cookie", sessionCookie);
    expect(protectedRes.status).toBe(200);
  });

  it("refuses a replayed claim", async () => {
    const { app, throttle } = createApp();
    const { token } = signClaim();
    await fromDashboard(request(app).get(`/auth/teamyou?claim=${token}`));

    const replay = await fromDashboard(
      request(app).get(`/auth/teamyou?claim=${token}`),
    );

    expect(replay.status).toBe(303);
    expect(replay.headers.location).toBe("/login.html?sso_error=used");
    expect(replay.headers["set-cookie"]).toBeUndefined();
    expect(throttle.recordLoginFailure).toHaveBeenCalled();
  });

  it("sends failures to the login page with a reason and counts them", async () => {
    const { app, throttle, claimStore } = createApp();
    const { token } = signClaim({ instance_id: "inst_other" });

    const res = await fromDashboard(
      request(app).get(`/auth/teamyou?claim=${token}`),
    );

    expect(res.headers.location).toBe(
      "/login.html?sso_error=wrong_instance",
    );
    expect(claimStore.consume).not.toHaveBeenCalled();
    expect(throttle.recordLoginFailure).toHaveBeenCalled();
  });

  it("stops at the throttle before checking the claim", async () => {
    const { app, throttle, claimStore } = createApp();
    throttle.evaluateLoginThrottle.mockReturnValue({
      blocked: true,
      retryAfterSec: 30,
    });

    const res = await fromDashboard(
      request(app).get(`/auth/teamyou?claim=${signClaim().token}`),
    );

    expect(res.headers.location).toBe("/login.html?sso_error=throttled");
    expect(claimStore.consume).not.toHaveBeenCalled();
  });

  it("does not exist when TeamYou sign-in is not configured", async () => {
    const { app } = createApp({ env: {}, password: "pw" });

    const res = await request(app).get(`/auth/teamyou?claim=x`);

    expect(res.status).toBe(404);
    const status = await request(app).get("/api/auth/status");
    expect(status.body).toEqual({
      authEnabled: true,
      methods: { password: true, teamyou: null },
      identity: null,
    });
  });

  it("disables password sign-in when the instance has no password", async () => {
    const { app } = createApp();

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: "" });

    expect(login.status).toBe(404);
    const protectedRes = await request(app).get("/api/protected");
    expect(protectedRes.status).toBe(401);
  });

  it("keeps password sign-in working alongside TeamYou during the transition", async () => {
    const { app } = createApp({ password: "setup-pw" });

    const wrong = await request(app)
      .post("/api/auth/login")
      .send({ password: "setup-pw-wrong" });
    const right = await request(app)
      .post("/api/auth/login")
      .send({ password: "setup-pw" });

    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    const cookie = right.headers["set-cookie"].join(";");
    expect(cookie).not.toContain("Secure");
    const status = await request(app)
      .get("/api/auth/status")
      .set("Cookie", right.headers["set-cookie"][0].split(";")[0]);
    expect(status.body.identity).toEqual({ method: "password" });
    expect(status.body.methods.password).toBe(true);
  });
});
