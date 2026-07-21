const {
  buildGogSkillContent,
  installGogCliSkill,
} = require("../../lib/server/gog-skill");

const createStateFs = ({ googleProvider = "", accounts = [], skillExists = false }) => {
  const statePath = "/openclaw/gogcli/state.json";
  const skillPath = "/openclaw/skills/gog-cli/SKILL.md";
  const stateJson = JSON.stringify({
    version: 2,
    googleProvider,
    accounts,
    gmailPush: { token: "", topics: {} },
  });
  return {
    statePath,
    skillPath,
    fs: {
      existsSync: vi.fn((p) => p === statePath || (skillExists && p === skillPath)),
      readFileSync: vi.fn((p) => {
        if (p === statePath) return stateJson;
        return "## Sheets\n\n```bash\ngog sheets get <id> 'Sheet1!A1:B2'\n```";
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
};

describe("server/gog-skill", () => {
  const kOriginalProviderEnv = process.env.ALPHACLAW_GOOGLE_PROVIDER;

  afterEach(() => {
    if (typeof kOriginalProviderEnv === "undefined") {
      delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
      return;
    }
    process.env.ALPHACLAW_GOOGLE_PROVIDER = kOriginalProviderEnv;
  });

  it("removes the gog-cli skill when the Google provider is not gog", () => {
    delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    const { fs, skillPath } = createStateFs({
      googleProvider: "composio",
      accounts: [
        {
          email: "chrys@example.com",
          client: "default",
          authenticated: true,
          services: ["sheets:read"],
        },
      ],
      skillExists: true,
    });

    installGogCliSkill({ fs, openclawDir: "/openclaw" });

    expect(fs.unlinkSync).toHaveBeenCalledWith(skillPath);
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(
      skillPath,
      expect.anything(),
    );
  });

  it("honors the ALPHACLAW_GOOGLE_PROVIDER env override", () => {
    process.env.ALPHACLAW_GOOGLE_PROVIDER = "none";
    const { fs, skillPath } = createStateFs({
      googleProvider: "",
      accounts: [
        {
          email: "chrys@example.com",
          client: "default",
          authenticated: true,
          services: ["sheets:read"],
        },
      ],
      skillExists: true,
    });

    installGogCliSkill({ fs, openclawDir: "/openclaw" });

    expect(fs.unlinkSync).toHaveBeenCalledWith(skillPath);
  });

  it("still installs the skill for authenticated accounts when provider is gog", () => {
    delete process.env.ALPHACLAW_GOOGLE_PROVIDER;
    const { fs, skillPath } = createStateFs({
      googleProvider: "gog",
      accounts: [
        {
          email: "chrys@example.com",
          client: "default",
          authenticated: true,
          services: ["sheets:read"],
        },
      ],
    });

    installGogCliSkill({ fs, openclawDir: "/openclaw" });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      skillPath,
      expect.stringContaining("# gog — Google Workspace CLI"),
    );
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("includes managed runtime guidance for direct gog shell usage", () => {
    const fs = {
      readFileSync: vi.fn(() => "## Sheets\n\n```bash\ngog sheets get <id> 'Sheet1!A1:B2'\n```"),
    };
    const content = buildGogSkillContent({
      fs,
      accounts: [
        {
          email: "chrys@example.com",
          client: "default",
          authenticated: true,
          services: ["sheets:read"],
        },
      ],
    });

    expect(content).toContain("## Runtime Notes");
    expect(content).toContain("$OPENCLAW_STATE_DIR");
    expect(content).toContain(
      'XDG_CONFIG_HOME="${OPENCLAW_STATE_DIR:-$OPENCLAW_HOME/.openclaw}"',
    );
    expect(content).toContain("--account <email>");
  });
});
