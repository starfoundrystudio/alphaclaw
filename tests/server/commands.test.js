const { sanitizeOnboardCommandForLog } = require("../../lib/server/commands");

describe("server/commands", () => {
  it("redacts secret-bearing onboarding flags in command logs", () => {
    const sanitized = sanitizeOnboardCommandForLog(
      'openclaw onboard "--gateway-token" "gw-secret" "--ai-gateway-api-key" "vck_live_secret" "--client-secret" "plain-secret" "--workspace" "/tmp/workspace"',
    );

    expect(sanitized).toContain('"--gateway-token" "***"');
    expect(sanitized).toContain('"--ai-gateway-api-key" "***"');
    expect(sanitized).toContain('"--client-secret" "***"');
    expect(sanitized).toContain('"--workspace" "/tmp/workspace"');
    expect(sanitized).not.toContain("gw-secret");
    expect(sanitized).not.toContain("vck_live_secret");
    expect(sanitized).not.toContain("plain-secret");
  });

  it("redacts known token prefixes even outside secret-looking flags", () => {
    const sanitized = sanitizeOnboardCommandForLog(
      'echo ghp_secret github_pat_secret sk-secret vck_secret',
    );

    expect(sanitized).not.toContain("ghp_secret");
    expect(sanitized).not.toContain("github_pat_secret");
    expect(sanitized).not.toContain("sk-secret");
    expect(sanitized).not.toContain("vck_secret");
    expect(sanitized).toContain("***");
  });
});
