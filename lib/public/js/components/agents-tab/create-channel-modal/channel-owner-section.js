import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { Badge } from "../../badge.js";
import { LoadingSpinner } from "../../loading-spinner.js";

const html = htm.bind(h);

const kProviderLabels = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

const PersonAvatar = ({ person = null }) =>
  person?.avatarUrl
    ? html`<img
        src=${person.avatarUrl}
        alt=""
        class="h-8 w-8 shrink-0 rounded-lg"
        aria-hidden="true"
      />`
    : html`<div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-field text-xs font-medium text-fg-muted"
        aria-hidden="true"
      >
        ${String(person?.name || "?").trim().charAt(0).toUpperCase()}
      </div>`;

const PersonRow = ({ person, onSelect, trailing = null }) => html`
  <button
    type="button"
    onclick=${() => onSelect(person)}
    class="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-field"
  >
    <${PersonAvatar} person=${person} />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm text-body">${person.name}</span>
      ${person.detail
        ? html`<span class="block truncate text-xs text-fg-dim">
            ${person.detail}
          </span>`
        : null}
    </span>
    ${trailing}
  </button>
`;

const kSlackRoleLabels = {
  primary_owner: "Workspace owner",
  owner: "Owner",
  admin: "Admin",
};

const SlackMemberPicker = ({ slack }) => {
  if (slack.loading) {
    return html`<div class="flex items-center gap-2 text-xs text-fg-muted">
      <${LoadingSpinner} className="h-3.5 w-3.5" />
      Loading workspace members...
    </div>`;
  }
  if (!slack.hasMembers) {
    return html`<${ActionButton}
      onClick=${slack.retry}
      tone="secondary"
      size="sm"
      idleLabel="Load members again"
    />`;
  }
  return html`
    <div class="space-y-2">
      <input
        type="text"
        value=${slack.query}
        onInput=${(event) => slack.setQuery(event.target.value)}
        placeholder="Find yourself by name"
        class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
      />
      <div class="space-y-0.5">
        ${slack.members.length === 0
          ? html`<p class="px-2 text-xs text-fg-dim">No one matches that name.</p>`
          : slack.members.map(
              (member) => html`<${PersonRow}
                key=${member.id}
                person=${{
                  id: member.id,
                  name: member.name || member.handle,
                  detail:
                    member.realName && member.realName !== member.name
                      ? member.realName
                      : member.handle
                        ? `@${member.handle}`
                        : "",
                  avatarUrl: member.avatarUrl,
                }}
                onSelect=${() => slack.selectMember(member)}
                trailing=${kSlackRoleLabels[member.role]
                  ? html`<${Badge} tone="neutral">${kSlackRoleLabels[member.role]}</${Badge}>`
                  : null}
              />`,
            )}
      </div>
      ${slack.truncated
        ? html`<p class="text-[11px] leading-4 text-fg-dim">
            Only the first 1,000 members are listed.
          </p>`
        : null}
    </div>
  `;
};

const TelegramStartPrompt = ({ telegram }) => {
  if (telegram.waiting) {
    return html`
      <div class="space-y-2">
        <div class="flex items-center gap-2 text-xs text-fg-muted">
          <${LoadingSpinner} className="h-3.5 w-3.5" />
          <span>
            Waiting for you to tap${" "}<strong class="text-body">Start</strong>${" "}in
            Telegram...
          </span>
        </div>
        <div class="flex flex-wrap gap-2">
          <a
            href=${telegram.link}
            target="_blank"
            rel="noreferrer"
            class="ac-btn-secondary inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium"
          >
            Open Telegram again
          </a>
          <${ActionButton}
            onClick=${telegram.cancel}
            tone="ghost"
            size="sm"
            idleLabel="Stop waiting"
          />
        </div>
      </div>
    `;
  }
  if (!telegram.link) {
    return html`<${ActionButton}
      onClick=${telegram.retry}
      tone="secondary"
      size="sm"
      idleLabel="Try again"
    />`;
  }
  return html`
    <div class="space-y-2">
      <a
        href=${telegram.link}
        target="_blank"
        rel="noreferrer"
        onclick=${telegram.waitForStart}
        class="ac-btn-primary inline-flex h-9 items-center justify-center rounded-xl px-3 text-sm font-medium"
      >
        Open Telegram
      </a>
      <p class="text-xs leading-5 text-fg-dim">
        Tap${" "}<strong class="text-fg-muted">Start</strong>${" "}in the chat
        that opens. The link works once and expires in 10 minutes.
      </p>
    </div>
  `;
};

const DiscordCandidates = ({ discord }) =>
  discord.candidates.length > 0
    ? html`<div class="space-y-0.5">
        ${discord.candidates.map(
          (candidate) => html`<${PersonRow}
            key=${candidate.id}
            person=${candidate}
            onSelect=${discord.selectCandidate}
          />`,
        )}
      </div>`
    : html`<p class="text-xs leading-5 text-fg-dim">
        Discord didn't say who owns this app. Use DM pairing instead.
      </p>`;

export const ChannelOwnerSection = ({ provider = "", channelOwner }) => {
  if (!channelOwner?.active) return null;
  const label = kProviderLabels[provider] || "this platform";
  const { choice, owner, lookupError } = channelOwner;

  if (choice === "pairing") {
    return html`
      <div class="ac-surface-inset rounded-xl p-4 space-y-2">
        <p class="text-sm font-medium text-body">Direct messages</p>
        <p class="text-xs leading-5 text-fg-muted">
          Anyone who messages the bot gets a pairing code, and you approve each
          one here.
        </p>
        <${ActionButton}
          onClick=${channelOwner.useOwner}
          tone="ghost"
          size="sm"
          idleLabel=${`Confirm my ${label} account instead`}
        />
      </div>
    `;
  }

  return html`
    <div class="ac-surface-inset rounded-xl p-4 space-y-3">
      <div class="space-y-1">
        <p class="text-sm font-medium text-body">Direct messages</p>
        <p class="text-xs leading-5 text-fg-muted">
          ${owner
            ? "Only you can message the bot directly. No pairing code needed."
            : `Confirm your ${label} account so only you can message the bot directly.`}
        </p>
      </div>

      ${owner
        ? html`<div class="flex items-center gap-3 rounded-lg border border-border bg-field px-3 py-2">
            <${PersonAvatar} person=${owner} />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-body">${owner.name}</p>
              ${owner.detail
                ? html`<p class="truncate text-xs text-fg-muted">${owner.detail}</p>`
                : null}
            </div>
            <${ActionButton}
              onClick=${channelOwner.clearOwner}
              tone="ghost"
              size="sm"
              idleLabel="Not you?"
            />
          </div>`
        : provider === "slack"
          ? html`<${SlackMemberPicker} slack=${channelOwner.slack} />`
          : provider === "telegram"
            ? html`<${TelegramStartPrompt} telegram=${channelOwner.telegram} />`
            : html`<${DiscordCandidates} discord=${channelOwner.discord} />`}

      ${lookupError
        ? html`<p class="text-xs text-status-error-muted">${lookupError}</p>`
        : null}

      <${ActionButton}
        onClick=${channelOwner.usePairing}
        tone="ghost"
        size="sm"
        idleLabel="Skip and use DM pairing"
      />
    </div>
  `;
};
