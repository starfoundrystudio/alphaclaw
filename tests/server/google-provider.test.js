const {
  createEmptyGoogleState,
  normalizeGoogleProviderValue,
  resolveGoogleProvider,
  setGoogleProvider,
  readGoogleState,
  writeGoogleState,
} = require("../../lib/server/google-state");

describe("server/google-state provider", () => {
  it("normalizes provider values and rejects unknown ones", () => {
    expect(normalizeGoogleProviderValue("gog")).toBe("gog");
    expect(normalizeGoogleProviderValue(" Composio ")).toBe("composio");
    expect(normalizeGoogleProviderValue("NONE")).toBe("none");
    expect(normalizeGoogleProviderValue("mcp")).toBe("");
    expect(normalizeGoogleProviderValue("")).toBe("");
    expect(normalizeGoogleProviderValue(undefined)).toBe("");
  });

  it("resolves provider with env > state > default precedence", () => {
    const state = { ...createEmptyGoogleState(), googleProvider: "composio" };

    expect(
      resolveGoogleProvider({ state, env: { ALPHACLAW_GOOGLE_PROVIDER: "none" } }),
    ).toEqual({ provider: "none", source: "env" });

    expect(resolveGoogleProvider({ state, env: {} })).toEqual({
      provider: "composio",
      source: "state",
    });

    expect(
      resolveGoogleProvider({ state: createEmptyGoogleState(), env: {} }),
    ).toEqual({ provider: "gog", source: "default" });
  });

  it("ignores invalid env override and falls through to state", () => {
    const state = { ...createEmptyGoogleState(), googleProvider: "composio" };
    expect(
      resolveGoogleProvider({
        state,
        env: { ALPHACLAW_GOOGLE_PROVIDER: "not-a-provider" },
      }),
    ).toEqual({ provider: "composio", source: "state" });
  });

  it("setGoogleProvider validates and persists through normalization", () => {
    const { state } = setGoogleProvider({
      state: createEmptyGoogleState(),
      provider: "composio",
    });
    expect(state.googleProvider).toBe("composio");
    expect(() =>
      setGoogleProvider({ state: createEmptyGoogleState(), provider: "bogus" }),
    ).toThrow(/Invalid Google provider/);
  });

  it("round-trips googleProvider through write and read", () => {
    const files = new Map();
    const fs = {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p);
      },
      writeFileSync: (p, data) => files.set(p, data),
    };
    const statePath = "/tmp/gogcli/state.json";
    const { state } = setGoogleProvider({
      state: createEmptyGoogleState(),
      provider: "composio",
    });
    writeGoogleState({ fs, statePath, state });

    const readBack = readGoogleState({ fs, statePath });
    expect(readBack.googleProvider).toBe("composio");
  });

  it("defaults googleProvider to unset for legacy state files", () => {
    const files = new Map([
      [
        "/tmp/gogcli/state.json",
        JSON.stringify({
          version: 2,
          accounts: [],
          gmailPush: { token: "", topics: {} },
        }),
      ],
    ]);
    const fs = {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p),
      writeFileSync: (p, data) => files.set(p, data),
    };
    const state = readGoogleState({ fs, statePath: "/tmp/gogcli/state.json" });
    expect(state.googleProvider).toBe("");
    expect(resolveGoogleProvider({ state, env: {} }).provider).toBe("gog");
  });
});
