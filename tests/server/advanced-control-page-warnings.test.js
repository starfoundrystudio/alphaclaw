const { parseHTML } = require("linkedom");
const {
  kManagedPageWarnings,
  renderAdvancedControlScript,
} = require("../../lib/server/routes/advanced-control");

// Runs the script Clawbridge injects into the Control UI against a small DOM
// with a controllable location and History API.
const loadPage = (pathname) => {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const listeners = {};
  const timers = [];
  const window = {
    location: { pathname },
    history: {
      pushState(_state, _title, url) {
        window.location.pathname = String(url);
      },
      replaceState(_state, _title, url) {
        window.location.pathname = String(url);
      },
    },
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    setInterval() {
      return 0;
    },
  };
  Object.defineProperty(document, "readyState", { value: "complete" });
  new Function("window", "document", renderAdvancedControlScript())(window, document);
  const flush = () => {
    while (timers.length) timers.shift()();
  };
  const panel = () => document.getElementById("teamyou-managed-page-warning");
  return { window, document, flush, panel };
};

describe("advanced Control UI page warnings", () => {
  it.each([
    ["/openclaw/settings/channels", "channels", "/#/general"],
    ["/openclaw/channels", "channels", "/#/general"],
    ["/openclaw/settings/model-providers", "models", "/#/models"],
    ["/openclaw/model-setup", "models", "/#/models"],
    ["/openclaw/settings/secrets", "secrets", "/#/credentials"],
  ])("warns on %s and links to the matching Clawbridge page", (path, id, href) => {
    const { panel } = loadPage(path);
    expect(panel()).not.toBeNull();
    expect(panel().dataset.warning).toBe(id);
    expect(panel().querySelector("a").getAttribute("href")).toBe(href);
    expect(panel().getAttribute("role")).toBe("alert");
  });

  it("shows nothing on pages Clawbridge does not manage", () => {
    const { panel } = loadPage("/openclaw/chat");
    expect(panel()).toBeNull();
  });

  it("follows in-page navigation and can be hidden for the current page", () => {
    const { window, flush, panel } = loadPage("/openclaw/chat");
    window.history.pushState({}, "", "/openclaw/settings/channels");
    flush();
    expect(panel().dataset.warning).toBe("channels");

    panel().querySelector("button").click();
    expect(panel()).toBeNull();

    window.history.pushState({}, "", "/openclaw/settings/model-providers");
    flush();
    expect(panel().dataset.warning).toBe("models");

    window.history.pushState({}, "", "/openclaw/chat");
    flush();
    expect(panel()).toBeNull();
  });

  it("covers the channel, model, and secret pages", () => {
    expect(kManagedPageWarnings.map((warning) => warning.id)).toEqual([
      "channels",
      "models",
      "secrets",
    ]);
  });
});
