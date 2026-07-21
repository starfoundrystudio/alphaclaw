const {
  createEmptyComposioState,
  normalizeComposioAccount,
  parseConnectedAccountsOutput,
  listGoogleWorkspaceAccounts,
  readComposioState,
  writeComposioState,
  refreshComposioState,
  composioStatePath,
} = require("../../lib/server/composio-state");

const createMemFs = () => {
  const files = new Map();
  return {
    files,
    fs: {
      existsSync: (p) => files.has(String(p)),
      readFileSync: (p) => {
        if (!files.has(String(p))) throw new Error("ENOENT");
        return files.get(String(p));
      },
      writeFileSync: (p, data) => files.set(String(p), String(data)),
      mkdirSync: () => {},
    },
  };
};

describe("server/composio-state", () => {
  it("normalizes accounts across CLI output shapes", () => {
    expect(
      normalizeComposioAccount({
        id: "ca_123",
        toolkit: { slug: "GMAIL" },
        status: "ACTIVE",
        userId: "chrys@example.com",
      }),
    ).toEqual({
      id: "ca_123",
      toolkit: "gmail",
      status: "ACTIVE",
      active: true,
      label: "chrys@example.com",
    });

    expect(
      normalizeComposioAccount({
        connected_account_id: "ca_456",
        app_name: "googlecalendar",
        status: "EXPIRED",
      }),
    ).toMatchObject({ id: "ca_456", toolkit: "googlecalendar", active: false });

    expect(normalizeComposioAccount({})).toBeNull();
  });

  it("parses list output as bare array or wrapped object", () => {
    expect(parseConnectedAccountsOutput('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(
      parseConnectedAccountsOutput('{"items":[{"id":"b"}]}'),
    ).toEqual([{ id: "b" }]);
    expect(
      parseConnectedAccountsOutput('{"data":[{"id":"c"}]}'),
    ).toEqual([{ id: "c" }]);
    expect(parseConnectedAccountsOutput("not json")).toBeNull();
  });

  it("filters google workspace accounts to active known toolkits", () => {
    const state = {
      accounts: [
        { id: "1", toolkit: "gmail", status: "ACTIVE", active: true },
        { id: "2", toolkit: "slack", status: "ACTIVE", active: true },
        { id: "3", toolkit: "googledrive", status: "EXPIRED", active: false },
      ],
    };
    expect(listGoogleWorkspaceAccounts(state).map((a) => a.id)).toEqual(["1"]);
  });

  it("round-trips state through write and read", () => {
    const { fs } = createMemFs();
    const statePath = composioStatePath("/openclaw");
    writeComposioState({
      fs,
      statePath,
      state: {
        cliInstalled: true,
        loggedIn: true,
        accounts: [{ id: "ca_1", toolkit: "gmail", status: "ACTIVE" }],
        refreshedAt: 123,
      },
    });
    const readBack = readComposioState({ fs, statePath });
    expect(readBack.cliInstalled).toBe(true);
    expect(readBack.accounts).toHaveLength(1);
    expect(readBack.accounts[0].toolkit).toBe("gmail");
    expect(readBack.refreshedAt).toBe(123);
  });

  it("returns empty state for missing or corrupt files", () => {
    const { fs } = createMemFs();
    expect(readComposioState({ fs, statePath: "/nope" })).toEqual(
      createEmptyComposioState(),
    );
    fs.writeFileSync("/bad", "{not json");
    expect(readComposioState({ fs, statePath: "/bad" })).toEqual(
      createEmptyComposioState(),
    );
  });

  describe("refreshComposioState", () => {
    it("records CLI missing when version check fails", async () => {
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "not found" }));
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(state.cliInstalled).toBe(false);
      expect(state.loggedIn).toBe(false);
      expect(composioCmd).toHaveBeenCalledTimes(1);
    });

    it("stores parsed accounts on successful list", async () => {
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "--version") return { ok: true, stdout: "1.0.0", stderr: "" };
        return {
          ok: true,
          stdout: JSON.stringify({
            items: [
              { id: "ca_1", toolkit: { slug: "gmail" }, status: "ACTIVE" },
              { id: "ca_2", toolkit: { slug: "slack" }, status: "ACTIVE" },
            ],
          }),
          stderr: "",
        };
      });
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(state.cliInstalled).toBe(true);
      expect(state.loggedIn).toBe(true);
      expect(state.accounts).toHaveLength(2);
      expect(listGoogleWorkspaceAccounts(state)).toHaveLength(1);
    });

    it("marks logged out on auth-flavored list failures", async () => {
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "--version") return { ok: true, stdout: "1.0.0", stderr: "" };
        return { ok: false, stdout: "", stderr: "Error: not logged in. Run composio login." };
      });
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(state.cliInstalled).toBe(true);
      expect(state.loggedIn).toBe(false);
      expect(state.lastError).toContain("not logged in");
    });
  });
});
