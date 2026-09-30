// Result pages for OAuth popups. These routes are unauthenticated and echo
// provider/query values, so nothing request-derived may reach the page as
// markup or script source: the postMessage payload is JSON serialized with
// every character that could end the <script> element or the string literal
// escaped, and the visible text is HTML-escaped.

const kInlineScriptEscapes = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

const serializeForInlineScript = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => kInlineScriptEscapes[character],
  );

const kHtmlEscapes = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => kHtmlEscapes[character]);

// targetOrigin "self" restricts delivery to an opener on the popup's own
// origin; "*" is only for callbacks served from a different host than the
// dashboard that opened them.
const sendOauthPopupResultPage = (
  res,
  { payload = {}, text = "", targetOrigin = "self" } = {},
) => {
  const targetOriginExpression =
    targetOrigin === "self"
      ? "window.location.origin"
      : serializeForInlineScript(String(targetOrigin));
  return res
    .type("html")
    .send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage(${serializeForInlineScript(payload)}, ${targetOriginExpression});
      window.close();
    </script><p>${escapeHtml(text)} You can close this window.</p></body></html>`);
};

module.exports = {
  escapeHtml,
  sendOauthPopupResultPage,
  serializeForInlineScript,
};
