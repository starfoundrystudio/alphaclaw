vi.mock("preact/hooks", () => ({
  useState: (initial) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useEffect: () => {},
  useMemo: (compute) => compute(),
}));

const textOf = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
};

describe("General gateway card Vault status", () => {
  it("keeps a failed first status request visible and replaces it after recovery", async () => {
    const { Gateway } = await import(
      "../../lib/public/js/components/gateway.js"
    );
    const failed = textOf(
      Gateway({ status: "running", vaultStatusError: new Error("HTTP 502") }),
    );
    expect(failed).toContain("Agent Vault:");
    expect(failed).toContain("status unavailable");
    const recovered = textOf(
      Gateway({
        status: "running",
        vaultStatus: { mode: "brokered", connected: true },
      }),
    );
    expect(recovered).toContain("Agent Vault:");
    expect(recovered).toContain("connected");
    expect(recovered).not.toContain("status unavailable");
  });

  it("does not present cached connectivity as current after a failed refresh", async () => {
    const { Gateway } = await import(
      "../../lib/public/js/components/gateway.js"
    );
    const text = textOf(
      Gateway({
        status: "running",
        vaultStatus: { mode: "brokered", connected: true },
        vaultStatusError: new Error("HTTP 502"),
      }),
    );
    expect(text).toContain("status unavailable");
    expect(text).not.toContain("connected");
  });

  it("keeps the Vault row hidden for a known unmanaged instance", async () => {
    const { Gateway } = await import(
      "../../lib/public/js/components/gateway.js"
    );
    expect(
      textOf(Gateway({ status: "running", vaultStatus: { mode: "disabled" } })),
    ).not.toContain("Agent Vault:");
  });
});
