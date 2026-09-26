const loadVaultApprovalWindow = async () =>
  import("../../lib/public/js/lib/vault-approval-window.js");

const makePopup = () => ({
  closed: false,
  opener: {},
  document: { title: "", body: { style: {}, innerHTML: "" } },
  location: { replace: vi.fn() },
  focus: vi.fn(),
  close: vi.fn(function close() {
    this.closed = true;
  }),
});

describe("frontend/vault-approval-window", () => {
  beforeEach(() => {
    vi.resetModules();
    global.window = { open: vi.fn() };
  });

  it("opens a blank tab without an opener handle", async () => {
    const popup = makePopup();
    global.window.open.mockReturnValue(popup);
    const mod = await loadVaultApprovalWindow();

    const opened = mod.openVaultApprovalWindow();

    expect(global.window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(opened).toBe(popup);
    expect(popup.opener).toBeNull();
    expect(popup.document.title).toBe("Agent Vault");
  });

  it("returns null when the browser blocks the tab", async () => {
    global.window.open.mockReturnValue(null);
    const mod = await loadVaultApprovalWindow();

    expect(mod.openVaultApprovalWindow()).toBeNull();
  });

  it("routes the pre-opened tab to the approval page", async () => {
    const popup = makePopup();
    const mod = await loadVaultApprovalWindow();

    const routed = mod.routeVaultApprovalWindow(
      popup,
      " https://vault.example/approve/42 ",
    );

    expect(routed).toBe(true);
    expect(popup.location.replace).toHaveBeenCalledWith(
      "https://vault.example/approve/42",
    );
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("closes the blank tab when there is no approval URL", async () => {
    const popup = makePopup();
    const mod = await loadVaultApprovalWindow();

    expect(mod.routeVaultApprovalWindow(popup, "")).toBe(false);
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it("reports failure when the tab was blocked or closed", async () => {
    const mod = await loadVaultApprovalWindow();
    const closed = { ...makePopup(), closed: true };

    expect(mod.routeVaultApprovalWindow(null, "https://vault.example")).toBe(
      false,
    );
    expect(mod.routeVaultApprovalWindow(closed, "https://vault.example")).toBe(
      false,
    );
    expect(closed.location.replace).not.toHaveBeenCalled();
  });

  describe("warmVaultOperator", () => {
    beforeEach(() => {
      global.fetch = vi.fn(() => Promise.resolve({}));
    });

    afterEach(() => {
      delete global.fetch;
    });

    it("touches the operator origin once without credentials", async () => {
      const mod = await loadVaultApprovalWindow();

      expect(
        mod.warmVaultOperator("https://agent-vault-x.tail123.ts.net/", {
          now: 1000,
        }),
      ).toBe(true);
      expect(
        mod.warmVaultOperator("https://agent-vault-x.tail123.ts.net", {
          now: 2000,
        }),
      ).toBe(false);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://agent-vault-x.tail123.ts.net/health",
        { mode: "no-cors", credentials: "omit", cache: "no-store" },
      );
    });

    it("warms again after the interval has passed", async () => {
      const mod = await loadVaultApprovalWindow();

      mod.warmVaultOperator("https://agent-vault-x.tail123.ts.net", { now: 0 });
      mod.warmVaultOperator("https://agent-vault-x.tail123.ts.net", {
        now: 6 * 60 * 1000,
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("ignores missing or non-tailnet origins", async () => {
      const mod = await loadVaultApprovalWindow();

      expect(mod.warmVaultOperator("")).toBe(false);
      expect(mod.warmVaultOperator("http://agent-vault-x.tail123.ts.net")).toBe(
        false,
      );
      expect(mod.warmVaultOperator("https://evil.example.com")).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("swallows network failures", async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error("offline")));
      const mod = await loadVaultApprovalWindow();

      expect(
        mod.warmVaultOperator("https://agent-vault-x.tail123.ts.net"),
      ).toBe(true);
      await Promise.resolve();
    });
  });
});
