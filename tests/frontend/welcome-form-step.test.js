const loadClaudeCliLoginWindow = async () =>
  import("../../lib/public/js/lib/claude-cli-login-window.js");

describe("frontend/welcome-form-step", () => {
  it("extracts the Claude CLI auth URL from login output", async () => {
    const { extractClaudeCliAuthUrl } = await loadClaudeCliLoginWindow();

    expect(
      extractClaudeCliAuthUrl(`
        To authenticate, open:
        https://claude.ai/oauth/authorize?code=true.
      `),
    ).toBe("https://claude.ai/oauth/authorize?code=true");
    expect(
      extractClaudeCliAuthUrl(
        "Visit https://example.com/one then https://console.anthropic.com/login",
      ),
    ).toBe("https://console.anthropic.com/login");
    expect(extractClaudeCliAuthUrl("no login link yet")).toBe("");
  });

  it("auto-adopts only after a successful Claude CLI login completion", async () => {
    const { shouldAutoAdoptClaudeCliLogin } = await loadClaudeCliLoginWindow();

    expect(
      shouldAutoAdoptClaudeCliLogin({
        event: "done",
        status: "complete",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      shouldAutoAdoptClaudeCliLogin({
        event: "done",
        status: "exited",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      shouldAutoAdoptClaudeCliLogin({
        event: "phase",
        status: "running",
        exitCode: null,
      }),
    ).toBe(false);
  });
});
