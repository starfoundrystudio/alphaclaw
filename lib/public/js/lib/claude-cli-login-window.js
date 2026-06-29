const kClaudeCliAuthWindowName = "claude-cli-auth";
const kClaudeCliAuthPopupFeatures = "popup=yes,width=640,height=780";

const trimAuthUrl = (value) =>
  String(value || "").replace(/[)\].,;:'"]+$/g, "");

export const extractClaudeCliAuthUrl = (output = "") => {
  const matches = String(output || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  return trimAuthUrl(
    matches.find((url) => /claude|anthropic/i.test(url)) || matches[0] || "",
  );
};

export const shouldAutoAdoptClaudeCliLogin = ({
  event = "",
  status = "",
  exitCode = null,
} = {}) => {
  const normalizedStatus = String(status || "").trim();
  if (String(event || "").trim() !== "done") return false;
  if (normalizedStatus !== "complete") return false;
  if (exitCode == null || exitCode === "") return true;
  return Number(exitCode) === 0;
};

export const openClaudeCliAuthPlaceholderWindow = () => {
  if (typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  const popup = window.open(
    "about:blank",
    kClaudeCliAuthWindowName,
    kClaudeCliAuthPopupFeatures,
  );
  if (!popup || popup.closed) return null;
  try {
    popup.document.title = "Claude login";
    popup.document.body.style.margin = "0";
    popup.document.body.style.background = "#0b111b";
    popup.document.body.style.color = "#d7dde8";
    popup.document.body.style.fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
    popup.document.body.innerHTML =
      '<div style="box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;"><div><p style="font-size:14px;margin:0 0 8px;">Starting Claude login...</p><p style="font-size:12px;line-height:1.5;margin:0;color:#8f9aaa;">Return to the AlphaClaw setup window after signing in.</p></div></div>';
  } catch {}
  return popup;
};

export const navigateClaudeCliAuthWindow = (popup, url) => {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) return false;
  if (!popup || popup.closed) return false;
  try {
    popup.location.href = targetUrl;
    popup.focus?.();
    return true;
  } catch {
    return false;
  }
};

export const closeClaudeCliAuthPlaceholderWindow = (popup) => {
  if (!popup || popup.closed) return;
  try {
    popup.close();
  } catch {}
};
