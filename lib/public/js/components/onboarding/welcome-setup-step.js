import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";

const html = htm.bind(h);
const kSetupTips = [
  {
    label: "🛡️ Safety tip",
    text: "Be careful what you give access to. Read access is always safer than write access.",
  },
  {
    label: "🧠 Best practice",
    text: "Trust but verify. Your agent may not always know what it's doing, so check the results.",
  },
  {
    label: "💡 Idea",
    text: "Ask your agent to create a morning briefing for you.",
  },
  {
    label: "🧠 Best practice",
    text: "Ask your agent to review its own code and make sure it's doing what you want it to do.",
  },
  {
    label: "💡 Idea",
    text: "Tell your agent to review the latest news and provide a summary.",
  },
  {
    label: "🛡️ Safety tip",
    text: "Be incredibly careful installing skills from the internet - they may contain malicious code.",
  },
];

export const WelcomeSetupStep = ({
  error,
  loading,
  handoff,
  onRetry,
  onBack,
}) => {
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    if (error || !loading) return;
    const timer = setInterval(() => {
      setTipIndex((idx) => (idx + 1) % kSetupTips.length);
    }, 5200);
    return () => clearInterval(timer);
  }, [error, loading]);

  if (error) {
    return html`
      <div class="py-4 flex flex-col items-center text-center gap-3">
        <h3 class="text-lg font-semibold text-body">Setup failed</h3>
        <p class="text-sm text-fg-muted">Fix the values and try again.</p>
      </div>
      <div
        class="bg-status-error-bg border border-status-error-border rounded-xl p-3 text-status-error text-sm"
      >
        ${error}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          onclick=${onBack}
          disabled=${loading}
          class="w-full text-sm font-medium px-4 py-3 rounded-xl transition-all ac-btn-secondary ${loading
            ? "opacity-50 cursor-not-allowed"
            : ""}"
        >
          Back
        </button>
        <button
          onclick=${onRetry}
          disabled=${loading}
          class="w-full text-sm font-medium px-4 py-3 rounded-xl transition-all ac-btn-primary ${loading
            ? "opacity-50 cursor-not-allowed"
            : ""}"
        >
          ${loading ? "Retrying..." : "Retry"}
        </button>
      </div>
    `;
  }

  if (handoff) {
    const isRecovering = handoff.status === "recovering";
    const isRedirecting =
      handoff.status === "redirecting" || handoff.status === "complete";
    const isDelayed = handoff.status === "delayed";
    const isTailnetHelp = handoff.status === "tailnet-help";
    const title = isRecovering
      ? "Checking setup completion..."
      : handoff.status === "complete"
        ? "Opening your dashboard..."
        : isRedirecting
          ? "Opening your Tailscale URL..."
          : isDelayed
            ? "This is taking longer than expected..."
          : isTailnetHelp
            ? "Waiting for your tailnet connection..."
            : "Your instance is starting...";
    const body = isRecovering
      ? "The setup connection was interrupted, so Clawbridge is verifying whether initialization completed."
      : handoff.status === "complete"
        ? "Clawbridge setup is complete."
        : isRedirecting
          ? "Your instance is ready. Opening your dashboard..."
          : isDelayed
            ? "Clawbridge is still waiting for the OpenClaw gateway to become ready. Recovery is continuing automatically; you do not need to restart setup."
          : isTailnetHelp
            ? "Clawbridge still cannot verify your private instance. Confirm that Tailscale is open and signed in on this device. If it is already connected, the OpenClaw gateway may still be recovering; Clawbridge will keep checking automatically."
            : "Clawbridge setup is complete. Your instance is restarting into its final configuration; this usually takes about a minute. You will be redirected automatically.";
    return html`
      <div class="py-4 flex flex-col items-center text-center gap-3">
        <${LoadingSpinner} className="h-7 w-7 text-body" />
        <h3 class="text-lg font-semibold text-body">${title}</h3>
        <p class="text-sm text-fg-muted">${body}</p>
      </div>
      ${isRedirecting && handoff.status !== "complete" && handoff.redirectUrl
        ? html`
            <a
              href=${handoff.redirectUrl}
              class="block w-full text-center text-sm font-medium px-4 py-3 rounded-xl transition-all ac-btn-primary"
            >
              Open dashboard
            </a>
          `
        : null}
      ${isTailnetHelp && handoff.setupUrl
        ? html`
            <div class="bg-field border border-border rounded-xl p-3 space-y-3">
              <div class="space-y-1">
                <p class="text-xs font-medium text-fg-muted">
                  Final Tailscale URL
                </p>
                <p class="text-sm text-body font-mono break-all">
                  ${handoff.setupUrl}
                </p>
              </div>
              <ul class="list-disc pl-5 space-y-1 text-xs text-fg-dim text-left">
                <li>
                  Install Tailscale on this device and sign in to the same
                  account used during setup.
                </li>
                <li>Accept the shared machine invite if Tailscale asks.</li>
                <li>
                  Once this device is connected to your tailnet, your
                  dashboard opens automatically.
                </li>
              </ul>
            </div>
          `
        : null}
    `;
  }

  const currentTip = kSetupTips[tipIndex];

  return html`
    <div class="relative min-h-[320px] pt-4 pb-20 flex">
      <div
        class="flex-1 flex flex-col items-center justify-center text-center gap-4"
      >
        <${LoadingSpinner} className="h-8 w-8 text-body" />
        <h3 class="text-lg font-semibold text-body">
          Initializing OpenClaw...
        </h3>
        <p class="text-sm text-fg-muted">This can take a few minutes</p>
      </div>
      <div
        class="absolute bottom-3 left-3 right-3 bg-field border border-border rounded-lg px-3 py-2 text-xs text-fg-muted"
      >
        <span class="text-fg-muted">${currentTip.label}: </span>
        ${currentTip.text}
      </div>
    </div>
  `;
};
