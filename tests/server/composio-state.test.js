const {
  createEmptyComposioState,
  normalizeComposioAccount,
  parseConnectionsListOutput,
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

    // Real 0.2.x connections entry: word_id is the identifier, alias the label
    expect(
      normalizeComposioAccount({
        toolkit: "gmail",
        status: "ACTIVE",
        alias: "work",
        word_id: "gmail_trick-stythe",
        permission_group: null,
      }),
    ).toEqual({
      id: "gmail_trick-stythe",
      toolkit: "gmail",
      status: "ACTIVE",
      active: true,
      label: "work",
    });

    expect(normalizeComposioAccount({})).toBeNull();
  });

  it("parses list output as bare array, wrapped object, or toolkit map", () => {
    expect(parseConnectionsListOutput('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(
      parseConnectionsListOutput('{"items":[{"id":"b"}]}'),
    ).toEqual([{ id: "b" }]);
    expect(
      parseConnectionsListOutput('{"data":[{"id":"c"}]}'),
    ).toEqual([{ id: "c" }]);
    expect(
      parseConnectionsListOutput('{"gmail":"ACTIVE","github":{"status":"EXPIRED"}}'),
    ).toEqual([
      { toolkit: "gmail", status: "ACTIVE" },
      { toolkit: "github", status: "EXPIRED" },
    ]);
    // Real 0.2.x CLI output: toolkit -> array of connection entries
    expect(
      parseConnectionsListOutput(
        JSON.stringify({
          gmail: [
            { status: "ACTIVE", alias: null, word_id: "gmail_trick-stythe", permission_group: null },
            { status: "EXPIRED", alias: null, word_id: "gmail_wodge-bedawn", permission_group: null },
          ],
        }),
      ),
    ).toEqual([
      { toolkit: "gmail", status: "ACTIVE", alias: null, word_id: "gmail_trick-stythe", permission_group: null },
      { toolkit: "gmail", status: "EXPIRED", alias: null, word_id: "gmail_wodge-bedawn", permission_group: null },
    ]);
    // Real CLI output for "no connections yet" is a bare {}
    expect(parseConnectionsListOutput("{}")).toEqual([]);
    expect(parseConnectionsListOutput("not json")).toBeNull();
    expect(parseConnectionsListOutput("")).toBeNull();
  });

  it("filters google workspace accounts to active known toolkits", () => {
    const state = {
      accounts: [
        { id: "1", toolkit: "gmail", status: "ACTIVE", active: true },
        { id: "2", toolkit: "slack", status: "ACTIVE", active: true },
        { id: "3", toolkit: "googledrive", status: "EXPIRED", active: false },
        { id: "4", toolkit: "google_calendar", status: "ACTIVE", active: true },
      ],
    };
    expect(listGoogleWorkspaceAccounts(state).map((a) => a.id)).toEqual(["1", "4"]);
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
      expect(composioCmd).toHaveBeenCalledWith("version", { quiet: true });
    });

    const kWhoamiJson =
      '{"account_type":"human","email":"bill@starfoundry.studio","current_org_name":"bill_workspace","enhanced_controls_enabled":null}';

    it("stores whoami identity and parsed accounts on success", async () => {
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "version") return { ok: true, stdout: "0.2.32", stderr: "" };
        if (cmd === "whoami") return { ok: true, stdout: kWhoamiJson, stderr: "" };
        return {
          ok: true,
          stdout: JSON.stringify([
            { id: "ca_1", toolkit: { slug: "gmail" }, status: "ACTIVE" },
            { id: "ca_2", toolkit: { slug: "slack" }, status: "ACTIVE" },
          ]),
          stderr: "",
        };
      });
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(composioCmd).toHaveBeenCalledWith("whoami", { quiet: true });
      expect(composioCmd).toHaveBeenCalledWith("connections list", { quiet: true });
      expect(state.cliInstalled).toBe(true);
      expect(state.loggedIn).toBe(true);
      expect(state.account).toEqual({
        email: "bill@starfoundry.studio",
        orgName: "bill_workspace",
      });
      expect(state.accounts).toHaveLength(2);
      expect(listGoogleWorkspaceAccounts(state)).toHaveLength(1);
    });

    it("preserves AlphaClaw-managed gmailWatch state across refreshes", async () => {
      const { fs } = createMemFs();
      const statePath = "/openclaw/composio/state.json";
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          cliInstalled: true,
          loggedIn: true,
          accounts: [],
          gmailWatch: { enabled: true, startedAt: 111, lastEventAt: 222 },
        }),
      );
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "version") return { ok: true, stdout: "0.2.32", stderr: "" };
        if (cmd === "whoami") return { ok: true, stdout: kWhoamiJson, stderr: "" };
        return { ok: true, stdout: "{}", stderr: "" };
      });
      const state = await refreshComposioState({ fs, statePath, composioCmd });
      expect(state.gmailWatch.enabled).toBe(true);
      expect(state.gmailWatch.startedAt).toBe(111);
      expect(state.gmailWatch.lastEventAt).toBe(222);
    });

    it("treats a logged-in session with zero connections as logged in", async () => {
      // Real CLI output: whoami emits JSON, connections list emits {}
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "version") return { ok: true, stdout: "0.2.32", stderr: "" };
        if (cmd === "whoami") return { ok: true, stdout: kWhoamiJson, stderr: "" };
        return { ok: true, stdout: "{}", stderr: "" };
      });
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(state.loggedIn).toBe(true);
      expect(state.accounts).toEqual([]);
      expect(state.lastError).toBe("");
    });

    it("treats empty non-TTY whoami output as logged out", async () => {
      // Real CLI behavior: with no session, commands print nothing to a pipe
      // and still exit 0.
      const { fs } = createMemFs();
      const composioCmd = vi.fn(async (cmd) => {
        if (cmd === "version") return { ok: true, stdout: "0.2.32", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      });
      const state = await refreshComposioState({
        fs,
        statePath: "/openclaw/composio/state.json",
        composioCmd,
      });
      expect(state.cliInstalled).toBe(true);
      expect(state.loggedIn).toBe(false);
      expect(state.lastError).toContain("composio login");
    });
  });
});
