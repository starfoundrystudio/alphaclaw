const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  collectAuthStoreSnapshots,
  restoreAuthStoreSnapshots,
  restoreOAuthCredentialMaterial,
  runOpenclawDoctorWithOauthGuard,
  shieldOAuthExpiries,
} = require("../../lib/cli/openclaw-doctor-oauth-guard");

const kOldExpires = Date.parse("2026-06-25T12:00:00.000Z");

const makeRoot = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-oauth-guard-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const agentDir = path.join(openclawDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return { rootDir, openclawDir, agentDir };
};

const writeAuthStore = (agentDir, store) => {
  fs.writeFileSync(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf8",
  );
};

const readAuthStore = (agentDir) =>
  JSON.parse(fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"));

const makeOauthStore = () => ({
  version: 1,
  profiles: {
    "openai:codex-cli": {
      type: "oauth",
      provider: "openai",
      access: "old-access",
      refresh: "old-refresh",
      expires: kOldExpires,
      email: "bill@example.com",
      idToken: "old-id-token",
    },
    "anthropic:key": {
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant",
    },
  },
});

describe("OpenClaw doctor OAuth guard", () => {
  let tempRoots = [];

  afterEach(() => {
    for (const rootDir of tempRoots) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  const createRoot = () => {
    const root = makeRoot();
    tempRoots.push(root.rootDir);
    return root;
  };

  it("temporarily makes OAuth profiles non-expiring and restores original material", () => {
    const { openclawDir, agentDir } = createRoot();
    writeAuthStore(agentDir, makeOauthStore());

    const shield = collectAuthStoreSnapshots({
      openclawDir,
      now: Date.parse("2026-06-26T00:00:00.000Z"),
    });
    const shielded = readAuthStore(agentDir);

    expect(shield.summary).toEqual({
      shieldedProfiles: 1,
      changedStores: 1,
    });
    expect(shielded.profiles["openai:codex-cli"].expires).toBeGreaterThan(kOldExpires);
    expect(shielded.profiles["openai:codex-cli"].access).toBe("old-access");
    expect(shielded.profiles["openai:codex-cli"].refresh).toBe("old-refresh");

    const restore = restoreAuthStoreSnapshots({
      snapshots: shield.snapshots,
    });
    const restored = readAuthStore(agentDir);

    expect(restore.restoredProfiles).toBe(1);
    expect(restored.profiles["openai:codex-cli"]).toMatchObject({
      access: "old-access",
      refresh: "old-refresh",
      expires: kOldExpires,
      idToken: "old-id-token",
    });
  });

  it("restores legacy OpenAI Codex OAuth material onto canonical OpenAI profiles", () => {
    const original = {
      profileId: "openai-codex:codex-cli",
      canonicalProfileId: "openai:codex-cli",
      provider: "openai",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: kOldExpires,
        email: "bill@example.com",
      },
    };
    const finalStore = {
      version: 1,
      profiles: {
        "openai:codex-cli": {
          type: "oauth",
          provider: "openai",
          access: "doctor-access",
          refresh: "doctor-refresh",
          expires: Date.parse("2026-07-01T00:00:00.000Z"),
          displayName: "Canonical profile",
        },
      },
    };

    const restored = restoreOAuthCredentialMaterial({
      store: finalStore,
      originals: [original],
    });

    expect(restored.restored).toBe(1);
    expect(restored.store.profiles["openai:codex-cli"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: kOldExpires,
      email: "bill@example.com",
      displayName: "Canonical profile",
    });
  });

  it("runs the wrapped command while auth profiles are shielded", () => {
    const { rootDir, openclawDir, agentDir } = createRoot();
    const authPath = path.join(agentDir, "auth-profiles.json");
    const markerPath = path.join(rootDir, "saw-shielded.txt");
    writeAuthStore(agentDir, makeOauthStore());

    const status = runOpenclawDoctorWithOauthGuard({
      rootDir,
      openclawDir,
      commandArgs: [
        process.execPath,
        "-e",
        `
          const fs = require("fs");
          const store = JSON.parse(fs.readFileSync(process.env.AUTH_PATH, "utf8"));
          const credential = store.profiles["openai:codex-cli"];
          if (credential.expires < Date.now() + 24 * 60 * 60 * 1000) process.exit(22);
          fs.writeFileSync(process.env.MARKER_PATH, "shielded");
        `,
      ],
      env: {
        ...process.env,
        AUTH_PATH: authPath,
        MARKER_PATH: markerPath,
      },
      stdio: "pipe",
      logger: { log() {}, error() {} },
    });

    expect(status).toBe(0);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("shielded");
    expect(readAuthStore(agentDir).profiles["openai:codex-cli"]).toMatchObject({
      access: "old-access",
      refresh: "old-refresh",
      expires: kOldExpires,
    });
  });

  it("does not shield OAuth profiles without refresh material", () => {
    const result = shieldOAuthExpiries({
      shieldExpiresAt: Date.parse("2026-07-01T00:00:00.000Z"),
      store: {
        version: 1,
        profiles: {
          "openai:missing": {
            type: "oauth",
            provider: "openai",
            access: "",
            refresh: "",
            expires: kOldExpires,
          },
        },
      },
    });

    expect(result.changed).toBe(false);
    expect(result.shielded).toBe(0);
    expect(result.store.profiles["openai:missing"].expires).toBe(kOldExpires);
  });
});
