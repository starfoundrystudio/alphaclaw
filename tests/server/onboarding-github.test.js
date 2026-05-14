const fs = require("fs");

const {
  cloneRepoToTemp,
  ensureGithubRepoAccessible,
  verifyGithubRepoForOnboarding,
} = require("../../lib/server/onboarding/github");

describe("server/onboarding/github", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("clones without embedding the github token in the command line", async () => {
    const shellCmd = vi.fn(async (cmd, opts = {}) => {
      expect(cmd).toContain('git clone --depth=1 "https://github.com/my-org/source-repo.git"');
      expect(cmd).not.toContain("ghp_secret_token_value");
      expect(opts.env?.ALPHACLAW_GITHUB_TOKEN).toBe("ghp_secret_token_value");
      expect(typeof opts.env?.GIT_ASKPASS).toBe("string");
      expect(fs.existsSync(opts.env.GIT_ASKPASS)).toBe(true);
      return "";
    });

    const result = await cloneRepoToTemp({
      repoUrl: "my-org/source-repo",
      githubToken: "ghp_secret_token_value",
      shellCmd,
    });

    expect(result.ok).toBe(true);
    expect(shellCmd).toHaveBeenCalledTimes(1);
    const [, opts] = shellCmd.mock.calls[0];
    expect(fs.existsSync(opts.env.GIT_ASKPASS)).toBe(false);
  });

  it("allows org-owned new repos when github token verification succeeds", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "repo" },
        json: async () => ({ login: "tokudu" }),
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        statusText: "Not Found",
        json: async () => ({ message: "Not Found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "" },
        json: async () => [{ login: "make-stories" }],
      });

    const result = await verifyGithubRepoForOnboarding({
      repoUrl: "make-stories/new-workspace",
      githubToken: "ghp_secret_token_value",
      mode: "new",
    });

    expect(result).toEqual({
      ok: true,
      repoExists: false,
      repoIsEmpty: false,
      createOwnerType: "org",
      viewerLogin: "tokudu",
    });
  });

  it("rejects new repos when the owner is not the token user or an accessible org", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "repo" },
        json: async () => ({ login: "chrysbtest" }),
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        statusText: "Not Found",
        json: async () => ({ message: "Not Found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "" },
        json: async () => [],
      });

    const result = await verifyGithubRepoForOnboarding({
      repoUrl: "chrybtest/test81",
      githubToken: "ghp_secret_token_value",
      mode: "new",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Repository owner "chrybtest"');
    expect(result.error).toContain('authenticated GitHub user "chrysbtest"');
  });

  it("creates org-owned new repos through the organization endpoint", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "repo" },
        json: async () => ({ login: "tokudu" }),
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        statusText: "Not Found",
        json: async () => ({ message: "Not Found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "" },
        json: async () => [{ login: "make-stories" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({}),
      });

    const result = await ensureGithubRepoAccessible({
      repoUrl: "make-stories/new-workspace",
      repoName: "new-workspace",
      githubToken: "ghp_secret_token_value",
    });

    expect(result).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/orgs/make-stories/repos",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "new-workspace",
          private: true,
          auto_init: false,
        }),
      }),
    );
  });

  it("flags a user-owned repo as already taken when listing shows a hidden match", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "repo" },
        json: async () => ({ login: "owner" }),
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        statusText: "Not Found",
        json: async () => ({ message: "Not Found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "" },
        json: async () => [{ name: "repo", full_name: "owner/repo" }],
      });

    const result = await verifyGithubRepoForOnboarding({
      repoUrl: "owner/repo",
      githubToken: "github_pat_hidden_repo_token",
      mode: "new",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Repository "owner/repo" already exists');
    expect(result.error).toContain("cannot inspect");
  });
});
