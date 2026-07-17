import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { SecretInput } from "../../secret-input.js";

const html = htm.bind(h);

export const kTelegramBotFatherUrl = "https://t.me/BotFather";

export const isTelegramBotTokenShape = (value) =>
  /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(String(value || "").trim());

export const TelegramChannelSetup = ({
  token = "",
  bot = null,
  verifying = false,
  verificationError = "",
  onTokenInput = () => {},
  onVerify = () => {},
}) => {
  const normalizedToken = String(token || "").trim();
  const canVerify = isTelegramBotTokenShape(normalizedToken) && !verifying;

  return html`
    <div class="space-y-4">
      <div class="ac-surface-inset rounded-xl p-4 space-y-3">
        <div class="flex items-start gap-3">
          <img
            src="/assets/icons/telegram.svg"
            alt=""
            class="mt-0.5 h-8 w-8 rounded-lg"
            aria-hidden="true"
          />
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium text-body">Create a Telegram bot</p>
            <p class="text-xs leading-5 text-fg-muted">
              BotFather will ask for the bot's display name and a unique
              username ending in${" "}<code>bot</code>.
            </p>
          </div>
        </div>
        <ol class="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-fg-muted">
          <li>Open the official${" "}<code>@BotFather</code> chat.</li>
          <li>Send${" "}<code>/newbot</code> and answer its two prompts.</li>
          <li>Copy the API token BotFather sends when the bot is created.</li>
        </ol>
        <a
          href=${kTelegramBotFatherUrl}
          target="_blank"
          rel="noreferrer"
          class="ac-btn-secondary inline-flex h-9 items-center justify-center rounded-xl px-3 text-sm font-medium"
        >
          Open @BotFather
        </a>
      </div>

      <div class="space-y-2">
        <label class="block space-y-1">
          <span class="text-xs font-medium text-fg-muted">Bot token</span>
          <${SecretInput}
            value=${token}
            onInput=${(event) => onTokenInput(event.target.value)}
            placeholder="123456789:AA..."
            isSecret=${true}
            inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
          />
          <p class="text-xs leading-5 text-fg-dim">
            Treat this token like a password. AlphaClaw verifies it directly
            with Telegram before saving it.
          </p>
        </label>
        <${ActionButton}
          onClick=${onVerify}
          disabled=${!canVerify}
          loading=${verifying}
          tone=${bot ? "secondary" : "primary"}
          size="sm"
          idleLabel=${bot ? "Verify again" : "Verify bot"}
          loadingLabel="Checking with Telegram..."
        />
        ${normalizedToken && !isTelegramBotTokenShape(normalizedToken)
          ? html`<p class="text-xs text-status-warning-muted">
              Paste the complete token from BotFather, including the colon.
            </p>`
          : null}
        ${verificationError
          ? html`<p class="text-xs text-status-error-muted">
              ${verificationError}
            </p>`
          : null}
      </div>

      ${bot
        ? html`
            <div
              class="rounded-xl border border-status-success-border bg-status-success-bg p-3"
            >
              <div class="flex items-center gap-3">
                <img
                  src="/assets/icons/telegram.svg"
                  alt=""
                  class="h-7 w-7 rounded-lg"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-body">
                    ${bot.name || "Telegram Bot"}
                  </p>
                  ${bot.username
                    ? html`<p class="truncate text-xs text-fg-muted">
                        @${bot.username}
                      </p>`
                    : null}
                </div>
                <span class="text-xs font-medium text-status-success">
                  Verified
                </span>
              </div>
            </div>
          `
        : null}

      <div class="rounded-xl border border-border bg-field p-3">
        <p class="text-xs leading-5 text-fg-muted">
          AlphaClaw starts this channel in private pairing mode. After it
          connects, message the bot in Telegram and approve your pairing request
          here. Other people cannot use the bot unless you approve them.
        </p>
      </div>
    </div>
  `;
};

export const TelegramChannelConnected = ({ bot = null, onDone = () => {} }) =>
  html`
    <div class="space-y-5 py-1">
      <div class="text-center space-y-3">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-status-success-bg"
        >
          <img
            src="/assets/icons/telegram.svg"
            alt=""
            class="h-8 w-8 rounded-lg"
            aria-hidden="true"
          />
        </div>
        <div class="space-y-1">
          <h3 class="text-base font-semibold text-body">Telegram connected</h3>
          <p class="text-sm text-fg-muted">
            ${bot?.username ? `@${bot.username}` : bot?.name || "Your bot"} is
            ready for its first pairing.
          </p>
        </div>
      </div>

      <div class="ac-surface-inset rounded-xl p-4 space-y-2">
        <p class="text-xs font-medium text-body">Finish pairing</p>
        <ol class="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-fg-muted">
          <li>Open the bot in Telegram and tap${" "}<strong>Start</strong>.</li>
          <li>Send any message to receive a pairing code.</li>
          <li>Return here and approve the request under Pending Pairings.</li>
        </ol>
      </div>

      <div class="grid gap-2 sm:grid-cols-2">
        ${bot?.link
          ? html`<a
              href=${bot.link}
              target="_blank"
              rel="noreferrer"
              class="ac-btn-secondary inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium"
            >
              Open @${bot.username}
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
