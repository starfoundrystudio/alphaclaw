const fs = require("fs");
const path = require("path");
const { resolveSetupUiUrl } = require("../../lib/server/onboarding/workspace");

describe("server/onboarding/workspace", () => {
  it("leads the injected AGENTS.md with the mandatory BOOTSTRAP.md first-run gate", () => {
    // The CLI-backend agent runtimes (claude-cli/codex) never receive
    // OpenClaw's system-prompt "Bootstrap Pending" section, so this injected
    // context file is the only hard bootstrap directive those runs see.
    // TeamYou activation depends on the ritual completing, so keep the gate
    // first and keep its blocking language intact.
    const agentsPrompt = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "setup", "core-prompts", "AGENTS.md"),
      "utf8",
    );
    expect(
      agentsPrompt.startsWith("### 🚨 First-Run Gate: BOOTSTRAP.md"),
    ).toBe(true);
    expect(agentsPrompt).toContain("mandatory first action");
    expect(agentsPrompt).toContain(
      "You MUST NOT send a generic greeting or reply normally first",
    );
    expect(agentsPrompt).toContain("**delete BOOTSTRAP.md**");
  });

  const kOriginalRailwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;

  afterEach(() => {
    if (typeof kOriginalRailwayPublicDomain === "undefined") {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      return;
    }
    process.env.RAILWAY_PUBLIC_DOMAIN = kOriginalRailwayPublicDomain;
  });

  it("falls back to Railway public domain when no explicit base URL is provided", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "alphaclaw-production.up.railway.app";

    expect(resolveSetupUiUrl("")).toBe(
      "https://alphaclaw-production.up.railway.app",
    );
  });
});
