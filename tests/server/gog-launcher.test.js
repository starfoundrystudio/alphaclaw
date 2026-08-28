const {
  buildInvocationArgs,
  calculateLeaseRuntimeMs,
  firstCommand,
  readFlag,
  resolveBrokeredAccount,
} = require("../../bin/alphaclaw-gog");

describe("managed gog launcher", () => {
  const state = {
    accounts: [
      {
        email: "one@example.com",
        client: "default",
        authenticated: true,
        brokerConsumer: "gog-1",
      },
      {
        email: "two@example.com",
        client: "personal",
        authenticated: true,
        brokerConsumer: "gog-2",
      },
    ],
  };

  it("parses global account/client flags without confusing their values for commands", () => {
    const args = [
      "--client",
      "personal",
      "gmail",
      "labels",
      "list",
      "--account=two@example.com",
    ];
    expect(firstCommand(args)).toBe("gmail");
    expect(readFlag(args, "--account", "-a")).toBe("two@example.com");
    expect(readFlag(args, "--client")).toBe("personal");
  });

  it("selects an exact broker slot for a multi-account invocation", () => {
    expect(
      resolveBrokeredAccount({
        args: [
          "gmail",
          "labels",
          "list",
          "--account",
          "two@example.com",
          "--client",
          "personal",
        ],
        state,
      }),
    ).toMatchObject({ brokerConsumer: "gog-2" });
  });

  it("fails closed when a multi-account invocation is ambiguous", () => {
    expect(() =>
      resolveBrokeredAccount({ args: ["gmail", "labels", "list"], state }),
    ).toThrow(/Multiple brokered Google accounts/);
  });

  it("passes the resolved account and client through to gog when omitted", () => {
    expect(
      buildInvocationArgs(["gmail", "labels", "list"], state.accounts[1]),
    ).toEqual([
      "--client",
      "personal",
      "--account",
      "two@example.com",
      "gmail",
      "labels",
      "list",
    ]);
  });

  it("rotates a long-running gog process before its access-token lease expires", () => {
    expect(
      calculateLeaseRuntimeMs({
        expiresAt: 4_600,
        nowSeconds: 1_000,
        leadSeconds: "600",
      }),
    ).toBe(3_000_000);
    expect(
      calculateLeaseRuntimeMs({
        expiresAt: 1_500,
        nowSeconds: 1_000,
        leadSeconds: "600",
      }),
    ).toBe(0);
  });
});
