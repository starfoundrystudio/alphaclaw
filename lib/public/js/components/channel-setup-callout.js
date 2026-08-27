import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { fetchOnboardStatus } from "../lib/api.js";
import { kChannelCalloutDismissedStorageKey } from "../lib/storage-keys.js";
import { ActionButton } from "./action-button.js";

const html = htm.bind(h);

const kBootstrapPollIntervalMs = 15000;

const readDismissed = () => {
  try {
    return (
      window.localStorage.getItem(kChannelCalloutDismissedStorageKey) === "true"
    );
  } catch {
    return false;
  }
};

const writeDismissed = () => {
  try {
    window.localStorage.setItem(kChannelCalloutDismissedStorageKey, "true");
  } catch {}
};

// Post-bootstrap nudge toward channel setup. Rendered in the chat pane once
// the agent's first-run ritual is done and no channel is configured yet —
// the moment the user most wants a way to keep chatting from their phone.
// The prompt-side counterpart (the AGENTS.md First-Run Gate's required
// Connect step) covers the conversational path; this covers the case where
// the agent forgets. Dismissal is per-browser and permanent.
export const ChannelSetupCallout = ({
  bootstrapPending = false,
  channelsConfigured = null,
}) => {
  const [bootstrapComplete, setBootstrapComplete] = useState(!bootstrapPending);
  const [dismissed, setDismissed] = useState(readDismissed);

  // The app shell fetches onboarding status once at load, so a ritual that
  // finishes mid-session would otherwise go unnoticed; poll until complete.
  useEffect(() => {
    if (bootstrapComplete) return undefined;
    let cancelled = false;
    const timerId = setInterval(async () => {
      try {
        const data = await fetchOnboardStatus();
        if (cancelled) return;
        if (data?.workspaceBootstrap?.complete === true) {
          setBootstrapComplete(true);
        }
      } catch {}
    }, kBootstrapPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timerId);
    };
  }, [bootstrapComplete]);

  if (dismissed) return null;
  if (!bootstrapComplete) return null;
  // null/undefined = channel state not loaded yet; don't flash the callout.
  if (channelsConfigured !== false) return null;

  return html`
    <div
      class="mx-4 mt-3 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p class="text-sm text-body">
        <span class="font-semibold">Keep chatting anywhere.</span>${" "}
        <span class="text-fg-muted">
          Connect Slack, Telegram, or Discord to reach your agent outside
          this dashboard.
        </span>
      </p>
      <div class="flex items-center gap-2 shrink-0">
        <${ActionButton}
          tone="primary"
          size="sm"
          idleLabel="Set up a channel"
          onClick=${() => {
            window.location.hash = "#/general";
          }}
        />
        <${ActionButton}
          tone="neutral"
          size="sm"
          idleLabel="Not now"
          onClick=${() => {
            writeDismissed();
            setDismissed(true);
          }}
        />
      </div>
    </div>
  `;
};
