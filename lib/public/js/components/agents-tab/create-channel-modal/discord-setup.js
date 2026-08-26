import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { SecretInput } from "../../secret-input.js";

const html = htm.bind(h);

export const kDiscordDeveloperPortalUrl =
  "https://discord.com/developers/applications";

export const isDiscordBotTokenShape = (value) =>
  String(value || "").trim().length >= 20;

const DiscordBotAvatar = ({ bot = null, className = "h-8 w-8" }) =>
  bot?.avatarUrl
    ? html`<img
        src=${bot.avatarUrl}
        alt=""
        class=${`${className} rounded-lg`}
        aria-hidden="true"
      />`
    : html`<img
        src="/assets/icons/discord.svg"
        alt=""
        class=${`${className} rounded-lg`}
        aria-hidden="true"
      />`;

const DiscordSettingStatus = ({ label, detail, enabled, recommended = false }) =>
  html`
    <div class="flex items-center justify-between gap-3 py-1">
      <div class="min-w-0">
        <p class="text-xs font-medium text-body">${label}</p>
        <p class="text-[11px] leading-4 text-fg-dim">${detail}</p>
      </div>
      <span
        class=${`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
          enabled
            ? "border-status-success-border bg-status-success-bg text-status-success"
            : recommended
              ? "border-status-warning-border bg-status-warning-bg text-status-warning-muted"
              : "border-status-error-border bg-status-error-bg text-status-error-muted"
        }`}
      >
        ${enabled ? "Enabled" : recommended ? "Recommended" : "Required"}
      </span>
    </div>
  `;

export const DiscordChannelSetup = ({
  token = "",
  bot = null,
  verifying = false,
  verificationError = "",
  vaultMode = false,
  onTokenInput = () => {},
  onVerify = () => {},
}) => {
  const normalizedToken = String(token || "").trim();
  const canVerify = isDiscordBotTokenShape(normalizedToken) && !verifying;
  const guilds = Array.isArray(bot?.guilds) ? bot.guilds : [];

  return html`
    <div class="space-y-4">
      ${bot
        ? null
        : html`<div class="ac-surface-inset rounded-xl p-4 space-y-3">
        <div class="flex items-start gap-3">
          <img
            src="/assets/icons/discord.svg"
            alt=""
            class="mt-0.5 h-8 w-8 rounded-lg"
            aria-hidden="true"
          />
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium text-body">Create a Discord bot</p>
            <p class="text-xs leading-5 text-fg-muted">
              Create the application in Discord, then let Clawbridge configure
              the installation link for you.
            </p>
          </div>
        </div>
        <ol class="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-fg-muted">
          <li>Open the Developer Portal and choose${" "}<strong>New Application</strong>.</li>
          <li>Open${" "}<strong>Bot</strong> in the sidebar.</li>
          <li>
            Choose${" "}<strong>Reset Token</strong>${" "}
            ${vaultMode
              ? "and copy the token for the Agent Vault approval page."
              : "and paste the token below."}
          </li>
        </ol>
        <a
          href=${kDiscordDeveloperPortalUrl}
          target="_blank"
          rel="noreferrer"
          class="ac-btn-secondary inline-flex h-9 items-center justify-center rounded-xl px-3 text-sm font-medium"
        >
          Open Developer Portal
        </a>
      </div>`}

      ${vaultMode
        ? bot
          ? null
          : html`<div class="rounded-xl border border-border bg-field p-3 space-y-2">
            <p class="text-xs font-medium text-body">
              While you are on the Bot page
            </p>
            <ul class="list-disc space-y-1 pl-5 text-xs leading-5 text-fg-muted">
              <li>
                Enable${" "}<strong>Message Content Intent</strong> (required).
              </li>
              <li>
                Enable${" "}<strong>Server Members Intent</strong> (recommended).
              </li>
            </ul>
          </div>`
        : html`<div class="space-y-2">
        <label class="block space-y-1">
          <span class="text-xs font-medium text-fg-muted">Bot token</span>
          <${SecretInput}
            value=${token}
            onInput=${(event) => onTokenInput(event.target.value)}
            placeholder="Paste Discord bot token"
            isSecret=${true}
            inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
          />
          <p class="text-xs leading-5 text-fg-dim">
            Treat this token like a password. Clawbridge verifies it directly
            with Discord before saving it.
          </p>
        </label>
        <${ActionButton}
          onClick=${onVerify}
          disabled=${!canVerify}
          loading=${verifying}
          tone=${bot ? "secondary" : "primary"}
          size="sm"
          idleLabel=${bot ? "Recheck Discord" : "Verify bot"}
          loadingLabel="Checking with Discord..."
        />
        ${normalizedToken && !isDiscordBotTokenShape(normalizedToken)
          ? html`<p class="text-xs text-status-warning-muted">
              Paste the complete token from the Bot page.
            </p>`
          : null}
        ${verificationError
          ? html`<p class="text-xs text-status-error-muted">
              ${verificationError}
            </p>`
          : null}
      </div>`}

      ${bot
        ? html`
            <div
              class="rounded-xl border border-status-success-border bg-status-success-bg p-3"
            >
              <div class="flex items-center gap-3">
                <${DiscordBotAvatar} bot=${bot} className="h-7 w-7" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-body">
                    ${bot.name || "Discord Bot"}
                  </p>
                  ${bot.username
                    ? html`<p class="truncate text-xs text-fg-muted">
                        @${bot.username}
                      </p>`
                    : null}
                </div>
                <span class="text-xs font-medium text-status-success">
                  Token verified
                </span>
              </div>
            </div>

            <div class="rounded-xl border border-border bg-field p-3 space-y-2">
              <div>
                <p class="text-xs font-medium text-body">
                  Enable gateway intents
                </p>
                <p class="text-[11px] leading-4 text-fg-dim">
                  Discord requires these switches on the application's Bot page.
                </p>
              </div>
              <div class="divide-y divide-border">
                <${DiscordSettingStatus}
                  label="Message Content Intent"
                  detail="Lets OpenClaw read normal server messages."
                  enabled=${!!bot.intents?.messageContent}
                />
                <${DiscordSettingStatus}
                  label="Server Members Intent"
                  detail="Supports role allowlists and member matching."
                  enabled=${!!bot.intents?.guildMembers}
                  recommended=${true}
                />
              </div>
              <div class="flex flex-wrap gap-2 pt-1">
                <a
                  href=${bot.developerPortalUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="ac-btn-secondary inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl px-4 text-sm font-medium leading-none transition-colors"
                >
                  Open Bot settings
                </a>
                <${ActionButton}
                  onClick=${onVerify}
                  disabled=${!canVerify}
                  loading=${verifying}
                  tone="secondary"
                  size="md"
                  idleLabel="Recheck intents"
                  loadingLabel="Rechecking..."
                />
              </div>
            </div>

            <div class="rounded-xl border border-border bg-field p-3 space-y-3">
              <div>
                <p class="text-xs font-medium text-body">Add bot to a server</p>
                <p class="text-[11px] leading-4 text-fg-dim">
                  This link pre-selects everything the bot needs — just pick
                  the server and approve.
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <a
                  href=${bot.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="ac-btn-primary inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl px-4 text-sm font-medium leading-none transition-colors"
                >
                  Add to Discord
                </a>
                <${ActionButton}
                  onClick=${onVerify}
                  disabled=${!canVerify}
                  loading=${verifying}
                  tone="secondary"
                  size="md"
                  idleLabel="Check installation"
                  loadingLabel="Checking..."
                />
              </div>
              ${guilds.length > 0
                ? html`<div
                    class="rounded-lg border border-status-success-border bg-status-success-bg px-3 py-2"
                  >
                    <p class="text-xs font-medium text-status-success">
                      Installed in ${guilds.length}${" "}
                      ${guilds.length === 1 ? "server" : "servers"}
                    </p>
                    <p class="mt-0.5 truncate text-[11px] text-fg-muted">
                      ${guilds.map((guild) => guild.name).join(", ")}
                    </p>
                  </div>`
                : html`<p class="text-xs text-status-warning-muted">
                    Add the bot to at least one server, then check the
                    installation.
                  </p>`}
            </div>
          `
        : null}

      <div class="rounded-xl border border-border bg-field p-3">
        <p class="text-xs leading-5 text-fg-muted">
          Direct messages require pairing. In servers, the bot only responds
          when mentioned.
        </p>
      </div>
    </div>
  `;
};

export const DiscordChannelConnected = ({ bot = null, onDone = () => {} }) =>
  html`
    <div class="space-y-5 py-1">
      <div class="text-center space-y-3">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-status-success-bg"
        >
          <${DiscordBotAvatar} bot=${bot} className="h-8 w-8" />
        </div>
        <div class="space-y-1">
          <h3 class="text-base font-semibold text-body">Discord connected</h3>
          <p class="text-sm text-fg-muted">
            ${bot?.name || bot?.username || "Your bot"} is ready for its first
            private pairing.
          </p>
        </div>
      </div>

      <div class="ac-surface-inset rounded-xl p-4 space-y-2">
        <p class="text-xs font-medium text-body">Finish pairing</p>
        <ol class="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-fg-muted">
          <li>Find the bot in your Discord server's member list.</li>
          <li>Open a direct message and send any message.</li>
          <li>Return here and approve the request under Pending Pairings.</li>
        </ol>
      </div>

      <div class="rounded-xl border border-border bg-field p-3">
        <p class="text-xs leading-5 text-fg-muted">
          In servers, mention the bot to talk to it. Direct messages require
          pairing.
        </p>
      </div>

      ${bot?.installUrl &&
      (!Array.isArray(bot?.guilds) || bot.guilds.length === 0)
        ? html`<div class="rounded-xl border border-status-warning-border bg-status-warning-bg p-3 space-y-2">
            <p class="text-xs font-medium text-status-warning-muted">
              The bot is not in any server yet — pairing needs one.
            </p>
            <a
              href=${bot.installUrl}
              target="_blank"
              rel="noreferrer"
              class="ac-btn-secondary inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-medium"
            >
              Add to server
            </a>
          </div>`
        : null}

      <div class="grid gap-2 sm:grid-cols-2">
        ${bot?.id
          ? html`<a
              href=${`https://discord.com/users/${bot.id}`}
              target="_blank"
              rel="noreferrer"
              class="ac-btn-secondary inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium"
            >
              Open in Discord
            </a>`
          : html`<div></div>`}
        <${ActionButton}
          onClick=${onDone}
          tone="primary"
          size="md"
          idleLabel="Continue to pairing"
          className="w-full"
        />
      </div>
    </div>
  `;
