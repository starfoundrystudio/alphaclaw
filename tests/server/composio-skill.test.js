const path = require("path");
const {
  buildComposioSkillContent,
  installComposioSkill,
} = require("../../lib/server/composio-skill");

const kRealFs = require("fs");

const kGoogleStatePath = "/openclaw/gogcli/state.json";
const kComposioStatePath = "/openclaw/composio/state.json";
const kSkillPath = "/openclaw/skills/composio/SKILL.md";

const createHybridFs = ({
  googleProvider = "composio",
  composioState = null,
  skillExists = false,
} = {}) => {
  const written = new Map();
  const googleStateJson = JSON.stringify({
    version: 2,
    googleProvider,
    accounts: [],
    gmailPush: { token: "", topics: {} },
  });
  const fs = {
    existsSync: (p) => {
      const target = String(p);
      if (target === kGoogleStatePath) return true;
      if (target === kComposioStatePath) return composioState !== null;
      if (target === kSkillPath) return skillExists || written.has(kSkillPath);
      return false;
    },
    readFileSync: (p, ...rest) => {
      const target = String(p);
      if (target === kGoogleStatePath) return googleStateJson;
      if (target === kComposioStatePath) return JSON.stringify(composioState);
      // Skill fragments are packaged files — read them for real.
      if (target.includes(path.join("setup", "skills", "composio"))) {
        return kRealFs.readFileSync(p, ...rest);
      }
      throw new Error("ENOENT");
    },
    writeFileSync: (p, data) => written.set(String(p), String(data)),
    unlinkSync: vi.fn(),
    mkdirSync: () => {},
  };
  return { fs, written };
};

const kActiveState = {
  version: 1,
  cliInstalled: true,
  loggedIn: true,
  accounts: [
    { id: "ca_1", toolkit: "gmail", status: "ACTIVE", label: "chrys@example.com" },
    { id: "ca_2", toolkit: "googlecalendar", status: "ACTIVE", label: "" },
  ],
  refreshedAt: 123,
};

describe("server/composio-skill", () => {
  const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;

  beforeEach(() => {
    delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
  });

  afterEach(() => {
    if (typeof kOriginalProviderEnv === "undefined") {
      delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
      return;
    }
    process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
  });

  it("builds skill content with linked toolkit sections", () => {
    const { fs } = createHybridFs({ composioState: kActiveState });
    const content = buildComposioSkillContent({
      fs,
      composioState: kActiveState,
    });
    expect(content).toContain("name: composio");
    expect(content).toContain("Gmail, Calendar");
    expect(content).toContain("composio tools execute");
    expect(content).toContain("chrys@example.com");
    expect(content).toContain("## Gmail (toolkit: `gmail`)");
    expect(content).toContain("## Calendar (toolkit: `googlecalendar`)");
    expect(content).not.toContain("## Drive (toolkit:");
  });

  it("returns null when the CLI is not installed", () => {
    const { fs } = createHybridFs();
    expect(
      buildComposioSkillContent({
        fs,
        composioState: { cliInstalled: false, accounts: [] },
      }),
    ).toBeNull();
  });

  it("includes link guidance when CLI is present but nothing is linked", () => {
    const { fs } = createHybridFs();
    const content = buildComposioSkillContent({
      fs,
      composioState: { cliInstalled: true, loggedIn: true, accounts: [] },
    });
    expect(content).toContain("No Google Workspace accounts are linked yet");
    expect(content).toContain("connected-accounts link");
  });

  it("installs the skill when provider is composio", () => {
    const { fs, written } = createHybridFs({ composioState: kActiveState });
    installComposioSkill({ fs, openclawDir: "/openclaw" });
    expect(written.get(kSkillPath)).toContain("# composio — managed app integrations");
  });

  it("removes the skill when provider is gog", () => {
    const { fs, written } = createHybridFs({
      googleProvider: "gog",
      composioState: kActiveState,
      skillExists: true,
    });
    installComposioSkill({ fs, openclawDir: "/openclaw" });
    expect(fs.unlinkSync).toHaveBeenCalledWith(kSkillPath);
    expect(written.has(kSkillPath)).toBe(false);
  });

  it("removes the skill when the CLI is missing", () => {
    const { fs, written } = createHybridFs({
      composioState: { version: 1, cliInstalled: false, accounts: [] },
      skillExists: true,
    });
    installComposioSkill({ fs, openclawDir: "/openclaw" });
    expect(fs.unlinkSync).toHaveBeenCalledWith(kSkillPath);
    expect(written.has(kSkillPath)).toBe(false);
  });
});
