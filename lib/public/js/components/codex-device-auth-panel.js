import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { copyTextToClipboard } from "../lib/clipboard.js";
import { kChatgptSecuritySettingsUrl } from "../lib/use-codex-device-auth.js";

const html = htm.bind(h);

const CopyCodeButton = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return html`
    <button
      type="button"
      onclick=${async () => {
        const ok = await copyTextToClipboard(value);
        if (!ok) return;
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      }}
      class="ac-btn-secondary inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium"
    >
      ${copied ? "Copied" : "Copy"}
    </button>
  `;
};

export const CodexDeviceAuthPanel = ({ device, onUseManual }) => {
  const {
    deviceAuth,
    deviceNotEnabled,
    deviceError,
    startDeviceAuth,
    cancelDeviceAuth,
  } = device;

  if (deviceNotEnabled) {
    return html`
      <div class="space-y-2">
        <div
          class="rounded-lg border border-status-warning-border bg-status-warning-bg px-3 py-2 text-xs text-status-warning"
        >
          Your ChatGPT account doesn't allow device code sign-in yet. Turn on
          "device code login" in${" "}
          <a
            href=${kChatgptSecuritySettingsUrl}
            target="_blank"
            rel="noreferrer"
            class="underline font-medium"
            >ChatGPT Settings ${"→"} Security</a
          >, then try again. Team and Enterprise workspaces need an admin to
          enable it.
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick=${startDeviceAuth}
            class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-secondary"
          >
            Try again
          </button>
          <button
            type="button"
            onclick=${onUseManual}
            class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-ghost"
          >
            Use manual sign-in
          </button>
        </div>
      </div>
    `;
  }

  if (deviceError) {
    return html`
      <div class="space-y-2">
        <div
          class="rounded-lg border border-status-warning-border bg-status-warning-bg px-3 py-2 text-xs text-status-warning"
        >
          ${deviceError}
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick=${startDeviceAuth}
            class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-secondary"
          >
            Try again
          </button>
          <button
            type="button"
            onclick=${onUseManual}
            class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-ghost"
          >
            Use manual sign-in
          </button>
        </div>
      </div>
    `;
  }

  if (!deviceAuth) return null;

  return html`
    <div class="space-y-2">
      <p class="text-xs text-fg-muted">
        Open${" "}
        <a
          href=${deviceAuth.verificationUrl}
          target="_blank"
          rel="noreferrer"
          class="underline font-medium"
          >auth.openai.com/codex/device</a
        >${" "}
        and enter this code:
      </p>
      <div class="flex items-center gap-2">
        <code
          class="text-sm font-semibold tracking-widest bg-field border border-border rounded-lg px-3 py-1.5 text-body"
          >${deviceAuth.userCode}</code
        >
        <${CopyCodeButton} value=${deviceAuth.userCode} />
      </div>
      <p class="text-xs text-fg-muted">
        Waiting for approval${"…"} Clawbridge finishes on its own once you
        approve. The code expires after 15 minutes.
      </p>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick=${cancelDeviceAuth}
          class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-ghost"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick=${onUseManual}
          class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-ghost"
        >
          Use manual sign-in
        </button>
      </div>
    </div>
  `;
};
