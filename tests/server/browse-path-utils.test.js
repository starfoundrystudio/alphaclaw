const {
  isAnchoredPolicyPath,
  matchesPolicyPathOrAncestor,
} = require("../../lib/server/routes/browse/path-utils");

describe("server/routes/browse/path-utils", () => {
  it("matches rooted runtime subtrees without matching workspace lookalikes", () => {
    const policy = {
      anchoredPaths: new Set(),
      anchoredSubtrees: new Set(["agents", "state"]),
      anchoredRootNames: new Set(),
    };

    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "agents/main/agent" })).toBe(true);
    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "state/openclaw.sqlite" })).toBe(true);
    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "workspace/project/agents" })).toBe(false);
  });

  it("applies wildcard root names only to directories", () => {
    const policy = {
      anchoredPaths: new Set(),
      anchoredSubtrees: new Set(),
      anchoredRootNames: new Set(["workspace", "workspace-*"]),
    };

    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "workspace-ops", isDirectory: true })).toBe(true);
    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "workspace-notes.txt" })).toBe(false);
    expect(isAnchoredPolicyPath({ ...policy, normalizedPath: "archive/workspace-ops", isDirectory: true })).toBe(false);
  });

  it("protects ancestors of suffix-matched managed paths", () => {
    const lockedPaths = new Set(["hooks/bootstrap/agents.md"]);

    expect(matchesPolicyPathOrAncestor(lockedPaths, "hooks")).toBe(true);
    expect(matchesPolicyPathOrAncestor(lockedPaths, "workspace/hooks")).toBe(true);
    expect(matchesPolicyPathOrAncestor(lockedPaths, "workspace/hooks/bootstrap")).toBe(true);
    expect(matchesPolicyPathOrAncestor(lockedPaths, "workspace/notes")).toBe(false);
  });
});
