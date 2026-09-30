const vm = require("vm");

// Values an attacker can place in an unauthenticated OAuth callback query to
// try to break out of the popup's inline script or the surrounding markup.
const kHostileOauthValues = [
  "\\';alert(document.domain)//",
  "\\\";alert(document.domain)//",
  "</script><script>alert(document.domain)</script>",
  "</SCRIPT ><img src=x onerror=alert(document.domain)>",
  "<!--<script>alert(document.domain)//",
  "line\u2028separator\u2029paragraph');alert(document.domain)//",
  "${alert(document.domain)}`",
];

// Asserts the page is a single inert script followed by plain text, then runs
// that script against a stub window. A breakout shows up as extra elements, a
// syntax error, or a call to the alert spy.
const runOauthPopupPage = (html, { origin = "https://dashboard.example" } = {}) => {
  const page = String(html);
  const match = page.match(
    /^<!DOCTYPE html><html><body><script>([\s\S]*)<\/script><p>([^<>]*)<\/p><\/body><\/html>$/,
  );
  if (!match) throw new Error(`Unexpected OAuth popup page shape: ${page}`);
  const [, script, text] = match;
  expect(page.match(/<script/gi)).toHaveLength(1);
  expect(page.match(/<\/script/gi)).toHaveLength(1);
  expect(page).not.toContain("<!--");
  // Raw line/paragraph separators are only a hazard inside script source.
  expect(script).not.toMatch(/[\u2028\u2029]/);

  const postMessage = vi.fn();
  const alert = vi.fn();
  const close = vi.fn();
  const context = vm.createContext({
    alert,
    document: { domain: "dashboard.example" },
    window: {
      alert,
      close,
      location: { origin },
      opener: { postMessage },
    },
  });
  new vm.Script(script).runInContext(context);

  expect(alert).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  const [message, targetOrigin] = postMessage.mock.calls[0];
  return {
    message: JSON.parse(JSON.stringify(message)),
    targetOrigin,
    text,
  };
};

module.exports = { kHostileOauthValues, runOauthPopupPage };
