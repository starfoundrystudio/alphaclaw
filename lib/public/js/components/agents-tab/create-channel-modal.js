import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { CloseIcon } from "../icons.js";
import { ModalShell } from "../modal-shell.js";
import { PageHeader } from "../page-header.js";
import { SecretInput } from "../secret-input.js";
import {
  fetchChannelAccountToken,
  inspectDiscordBotToken,
  inspectSlackCredentials,
  inspectTelegramBotToken,
} from "../../lib/api.js";
import { isSingleAccountChannelProvider } from "../../lib/channel-provider-availability.js";
import { ALL_CHANNELS, getChannelMeta } from "../channels.js";
import {
  DiscordChannelConnected,
  DiscordChannelSetup,
  isDiscordBotTokenShape,
} from "./create-channel-modal/discord-setup.js";
import {
  isTelegramBotTokenShape,
  TelegramChannelConnected,
  TelegramChannelSetup,
} from "./create-channel-modal/telegram-setup.js";
import {
  isSlackAppTokenShape,
  isSlackBotTokenShape,
  SlackChannelConnected,
  SlackChannelSetup,
} from "./create-channel-modal/slack-setup.js";

const html = htm.bind(h);

const kChannelEnvKeys = {
  telegram: "TELEGRAM_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  slack: "SLACK_BOT_TOKEN",
  whatsapp: "WHATSAPP_OWNER_NUMBER",
};

const kChannelExtraEnvKeys = {
  slack: "SLACK_APP_TOKEN",
};

const slugifyChannelAccountId = (value) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const deriveChannelEnvKey = ({ provider, accountId }) => {
  const baseKey = kChannelEnvKeys[String(provider || "").trim()] || "";
  const normalizedAccountId = String(accountId || "").trim();
  if (!baseKey) return "";
  if (!normalizedAccountId || normalizedAccountId === "default") return baseKey;
  return `${baseKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
};
const deriveChannelExtraEnvKey = ({ provider, accountId, index = 0 }) => {
  const baseKeys = [kChannelExtraEnvKeys[String(provider || "").trim()]].filter(
    Boolean,
  );
  const baseKey = String(baseKeys[index] || "").trim();
  const normalizedAccountId = String(accountId || "").trim();
  if (!baseKey) return "";
  if (!normalizedAccountId || normalizedAccountId === "default") return baseKey;
  return `${baseKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
};
const isMaskedTokenValue = (value) => /^\*+$/.test(String(value || "").trim());
export const CreateChannelModal = ({
  visible = false,
  loading = false,
  createLoadingLabel = "Creating...",
  agents = [],
  existingChannels = [],
  mode = "create",
  account = null,
  initialAgentId = "",
  initialProvider = "",
  onClose = () => {},
  onSubmit = async () => {},
}) => {
  const isEditMode = mode === "edit";
  const [provider, setProvider] = useState("telegram");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [initialToken, setInitialToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState("");
  const [nameEditedManually, setNameEditedManually] = useState(false);
  const [loadingToken, setLoadingToken] = useState(false);
  const [telegramBot, setTelegramBot] = useState(null);
  const [verifiedTelegramToken, setVerifiedTelegramToken] = useState("");
  const [verifyingTelegram, setVerifyingTelegram] = useState(false);
  const [telegramVerificationError, setTelegramVerificationError] =
    useState("");
  const [telegramCreated, setTelegramCreated] = useState(false);
  const [discordBot, setDiscordBot] = useState(null);
  const [verifiedDiscordToken, setVerifiedDiscordToken] = useState("");
  const [verifyingDiscord, setVerifyingDiscord] = useState(false);
  const [discordVerificationError, setDiscordVerificationError] =
    useState("");
  const [discordCreated, setDiscordCreated] = useState(false);
  const [slackIdentity, setSlackIdentity] = useState(null);
  const [verifiedSlackBotToken, setVerifiedSlackBotToken] = useState("");
  const [verifiedSlackAppToken, setVerifiedSlackAppToken] = useState("");
  const [verifyingSlack, setVerifyingSlack] = useState(false);
  const [slackVerificationError, setSlackVerificationError] = useState("");
  const [slackCreated, setSlackCreated] = useState(false);
  const [slackAppName, setSlackAppName] = useState("AlphaClaw");

  useEffect(() => {
    if (!visible) return;
    const nextProvider = isEditMode
      ? String(account?.provider || "").trim() || "telegram"
      : ALL_CHANNELS.includes(initialProvider)
        ? initialProvider
        : ALL_CHANNELS[0] || "telegram";
    const providerLabel = getChannelMeta(nextProvider).label || "Channel";
    const nextSelectedChannel =
      existingChannels.find(
        (entry) =>
          String(entry?.channel || "").trim() ===
          String(nextProvider || "").trim(),
      ) || null;
    const nextProviderHasAccounts =
      Array.isArray(nextSelectedChannel?.accounts) &&
      nextSelectedChannel.accounts.length > 0;
    const nextName = isEditMode
      ? String(account?.name || "").trim() || providerLabel
      : nextProviderHasAccounts
        ? ""
        : providerLabel;
    const nextAgentId = isEditMode
      ? String(account?.ownerAgentId || "").trim() ||
        String(initialAgentId || "").trim() ||
        String(agents[0]?.id || "").trim()
      : String(initialAgentId || "").trim() ||
        String(agents[0]?.id || "").trim();
    setProvider(nextProvider);
    setName(nextName);
    const nextToken = isEditMode
      ? (() => {
          const raw = String(account?.token || "").trim();
          return isMaskedTokenValue(raw) ? "" : raw;
        })()
      : "";
    setToken(nextToken);
    setInitialToken(nextToken);
    setAppToken("");
    setAgentId(nextAgentId);
    setError("");
    setNameEditedManually(isEditMode);
    setTelegramBot(null);
    setVerifiedTelegramToken("");
    setVerifyingTelegram(false);
    setTelegramVerificationError("");
    setTelegramCreated(false);
    setDiscordBot(null);
    setVerifiedDiscordToken("");
    setVerifyingDiscord(false);
    setDiscordVerificationError("");
    setDiscordCreated(false);
    setSlackIdentity(null);
    setVerifiedSlackBotToken("");
    setVerifiedSlackAppToken("");
    setVerifyingSlack(false);
    setSlackVerificationError("");
    setSlackCreated(false);
    setSlackAppName("AlphaClaw");
  }, [
    visible,
    initialAgentId,
    initialProvider,
    isEditMode,
    account,
  ]);

  const selectedChannel = useMemo(
    () =>
      existingChannels.find(
        (entry) =>
          String(entry?.channel || "").trim() === String(provider || "").trim(),
      ) || null,
    [existingChannels, provider],
  );

  const providerHasAccounts = useMemo(
    () =>
      Array.isArray(selectedChannel?.accounts) &&
      selectedChannel.accounts.length > 0,
    [selectedChannel],
  );
  useEffect(() => {
    if (nameEditedManually) return;
    const providerLabel = getChannelMeta(provider).label || "Channel";
    if (!isEditMode && providerHasAccounts) {
      setName("");
      return;
    }
    setName(providerLabel);
  }, [provider, providerHasAccounts, nameEditedManually, isEditMode]);
  const normalizedProvider = String(provider || "").trim();
  const isSingleAccountProvider = isSingleAccountChannelProvider(provider);
  const needsAppToken = normalizedProvider === "slack";
  const isWhatsApp = normalizedProvider === "whatsapp";
  const isTelegramCreate =
    !isEditMode && normalizedProvider === "telegram";
  const isDiscordCreate = !isEditMode && normalizedProvider === "discord";
  const isSlackCreate = !isEditMode && normalizedProvider === "slack";
  const isGuidedBotCreate =
    isTelegramCreate || isDiscordCreate || isSlackCreate;

  const accountId = useMemo(() => {
    if (isEditMode) {
      return String(account?.id || "").trim() || "default";
    }
    if (isSingleAccountProvider) return "default";
    if (!providerHasAccounts) return "default";
    return slugifyChannelAccountId(
      isTelegramCreate ? telegramBot?.username || name : name,
    );
  }, [
    name,
    providerHasAccounts,
    isEditMode,
    account,
    isSingleAccountProvider,
    isTelegramCreate,
    telegramBot,
  ]);

  const envKey = useMemo(
    () => deriveChannelEnvKey({ provider, accountId }),
    [provider, accountId],
  );
  const extraEnvKey = useMemo(
    () =>
      deriveChannelExtraEnvKey({
        provider,
        accountId,
      }),
    [provider, accountId],
  );
  const accountExists = useMemo(
    () =>
      Array.isArray(selectedChannel?.accounts) &&
      selectedChannel.accounts.some(
        (entry) =>
          String(entry?.id || "").trim() === String(accountId || "").trim(),
      ),
    [selectedChannel, accountId],
  );
  useEffect(() => {
    if (!visible || !isEditMode) return;
    let cancelled = false;
    const loadToken = async () => {
      setLoadingToken(true);
      try {
        const result = await fetchChannelAccountToken({
          provider,
          accountId,
        });
        if (cancelled) return;
        const nextToken = String(result?.token || "");
        const nextAppToken = String(result?.appToken || "");
        setToken(nextToken);
        setInitialToken(nextToken);
        setAppToken(nextAppToken);
      } catch {
        // Keep existing fallback value.
      } finally {
        if (!cancelled) {
          setLoadingToken(false);
        }
      }
    };
    loadToken();
    return () => {
      cancelled = true;
    };
  }, [visible, isEditMode, provider, accountId]);

  const canSubmit =
    !!String(provider || "").trim() &&
    !!String(name || "").trim() &&
    !!String(accountId || "").trim() &&
    !!String(agentId || "").trim() &&
    (isEditMode || !!String(token || "").trim()) &&
    (!isTelegramCreate ||
      (!!telegramBot &&
        String(verifiedTelegramToken || "").trim() ===
          String(token || "").trim())) &&
    (!isDiscordCreate ||
      (!!discordBot &&
        !!discordBot.intents?.messageContent &&
        Array.isArray(discordBot.guilds) &&
        discordBot.guilds.length > 0 &&
        String(verifiedDiscordToken || "").trim() ===
          String(token || "").trim())) &&
    (!isSlackCreate ||
      (!!slackIdentity &&
        String(verifiedSlackBotToken || "").trim() ===
          String(token || "").trim() &&
        String(verifiedSlackAppToken || "").trim() ===
          String(appToken || "").trim() &&
        (!slackIdentity.scopes?.checked ||
          !Array.isArray(slackIdentity.scopes?.missing) ||
          slackIdentity.scopes.missing.length === 0))) &&
    (isEditMode || !needsAppToken || !!String(appToken || "").trim()) &&
    (isEditMode || !accountExists) &&
    !loadingToken;

  if (!visible) return null;

  const handleTelegramTokenInput = (nextToken) => {
    setToken(nextToken);
    if (
      String(nextToken || "").trim() !==
      String(verifiedTelegramToken || "").trim()
    ) {
      setTelegramBot(null);
      setVerifiedTelegramToken("");
    }
    setTelegramVerificationError("");
    setError("");
  };

  const handleVerifyTelegram = async () => {
    const normalizedToken = String(token || "").trim();
    if (!isTelegramBotTokenShape(normalizedToken)) {
      setTelegramVerificationError(
        "Paste the complete bot token from @BotFather.",
      );
      return;
    }
    setVerifyingTelegram(true);
    setTelegramVerificationError("");
    try {
      const result = await inspectTelegramBotToken(normalizedToken);
      const bot = result?.bot || null;
      if (!bot) throw new Error("Telegram did not return bot details");
      setTelegramBot(bot);
      setVerifiedTelegramToken(normalizedToken);
      setName(String(bot.name || bot.username || "Telegram Bot").trim());
      setNameEditedManually(false);
    } catch (verificationError) {
      setTelegramBot(null);
      setVerifiedTelegramToken("");
      setTelegramVerificationError(
        verificationError.message || "Could not verify this Telegram bot",
      );
    } finally {
      setVerifyingTelegram(false);
    }
  };

  const handleDiscordTokenInput = (nextToken) => {
    setToken(nextToken);
    if (
      String(nextToken || "").trim() !==
      String(verifiedDiscordToken || "").trim()
    ) {
      setDiscordBot(null);
      setVerifiedDiscordToken("");
    }
    setDiscordVerificationError("");
    setError("");
  };

  const handleVerifyDiscord = async () => {
    const normalizedToken = String(token || "").trim();
    if (!isDiscordBotTokenShape(normalizedToken)) {
      setDiscordVerificationError(
        "Paste the complete bot token from the Discord Developer Portal.",
      );
      return;
    }
    setVerifyingDiscord(true);
    setDiscordVerificationError("");
    try {
      const result = await inspectDiscordBotToken(normalizedToken);
      const bot = result?.bot || null;
      if (!bot) throw new Error("Discord did not return bot details");
      setDiscordBot(bot);
      setVerifiedDiscordToken(normalizedToken);
      setName(String(bot.name || bot.username || "Discord Bot").trim());
      setNameEditedManually(false);
    } catch (verificationError) {
      setDiscordBot(null);
      setVerifiedDiscordToken("");
      setDiscordVerificationError(
        verificationError.message || "Could not verify this Discord bot",
      );
    } finally {
      setVerifyingDiscord(false);
    }
  };

  const invalidateSlackVerification = () => {
    setSlackIdentity(null);
    setVerifiedSlackBotToken("");
    setVerifiedSlackAppToken("");
  };

  const handleSlackBotTokenInput = (nextToken) => {
    setToken(nextToken);
    if (
      String(nextToken || "").trim() !==
      String(verifiedSlackBotToken || "").trim()
    ) {
      invalidateSlackVerification();
    }
    setSlackVerificationError("");
    setError("");
  };

  const handleSlackAppTokenInput = (nextToken) => {
    setAppToken(nextToken);
    if (
      String(nextToken || "").trim() !==
      String(verifiedSlackAppToken || "").trim()
    ) {
      invalidateSlackVerification();
    }
    setSlackVerificationError("");
    setError("");
  };

  const handleVerifySlack = async () => {
    const normalizedBotToken = String(token || "").trim();
    const normalizedAppToken = String(appToken || "").trim();
    if (!isSlackBotTokenShape(normalizedBotToken)) {
      setSlackVerificationError(
        "Paste the complete Bot User OAuth Token beginning with xoxb-.",
      );
      return;
    }
    if (!isSlackAppTokenShape(normalizedAppToken)) {
      setSlackVerificationError(
        "Paste the complete App-Level Token beginning with xapp-.",
      );
      return;
    }
    setVerifyingSlack(true);
    setSlackVerificationError("");
    try {
      const result = await inspectSlackCredentials({
        botToken: normalizedBotToken,
        appToken: normalizedAppToken,
      });
      const slack = result?.slack || null;
      if (!slack) throw new Error("Slack did not return workspace details");
      setSlackIdentity(slack);
      setVerifiedSlackBotToken(normalizedBotToken);
      setVerifiedSlackAppToken(normalizedAppToken);
      setName(
        String(slack.workspace?.name || slack.bot?.name || "Slack").trim(),
      );
      setNameEditedManually(false);
    } catch (verificationError) {
      invalidateSlackVerification();
      setSlackVerificationError(
        verificationError.message || "Could not verify these Slack tokens",
      );
    } finally {
      setVerifyingSlack(false);
    }
  };

  const handleSubmit = async () => {
    if (!String(name || "").trim()) {
      setError("Name is required");
      return;
    }
    if (!String(accountId || "").trim()) {
      setError("Channel id could not be derived from the name");
      return;
    }
    if (!isEditMode && !String(token || "").trim()) {
      setError("Token is required");
      return;
    }
    if (
      isTelegramCreate &&
      (!telegramBot ||
        String(verifiedTelegramToken || "").trim() !==
          String(token || "").trim())
    ) {
      setError("Verify the Telegram bot before connecting it");
      return;
    }
    if (
      isDiscordCreate &&
      (!discordBot ||
        String(verifiedDiscordToken || "").trim() !==
          String(token || "").trim())
    ) {
      setError("Verify the Discord bot before connecting it");
      return;
    }
    if (isDiscordCreate && !discordBot.intents?.messageContent) {
      setError("Enable Message Content Intent and recheck Discord");
      return;
    }
    if (
      isSlackCreate &&
      (!slackIdentity ||
        String(verifiedSlackBotToken || "").trim() !==
          String(token || "").trim() ||
        String(verifiedSlackAppToken || "").trim() !==
          String(appToken || "").trim())
    ) {
      setError("Verify both Slack tokens before connecting the app");
      return;
    }
    if (
      isSlackCreate &&
      slackIdentity.scopes?.checked &&
      Array.isArray(slackIdentity.scopes?.missing) &&
      slackIdentity.scopes.missing.length > 0
    ) {
      setError("Add the missing Slack bot scopes and verify again");
      return;
    }
    if (
      isDiscordCreate &&
      (!Array.isArray(discordBot.guilds) || discordBot.guilds.length === 0)
    ) {
      setError("Add the Discord bot to a server and check the installation");
      return;
    }
    if (!isEditMode && needsAppToken && !String(appToken || "").trim()) {
      setError("App Token is required for Slack");
      return;
    }
    if (!String(agentId || "").trim()) {
      setError("Agent is required");
      return;
    }
    if (!isEditMode && accountExists) {
      setError("That channel id is already configured for this provider");
      return;
    }

    setError("");
    const trimmedToken = String(token || "").trim();
    const tokenWasUpdated =
      trimmedToken && trimmedToken !== String(initialToken || "").trim();
    const trimmedAppToken = String(appToken || "").trim();
    try {
      await onSubmit({
        provider,
        name: String(name || "").trim(),
        accountId,
        agentId,
        ...(tokenWasUpdated ? { token: trimmedToken } : {}),
        ...(needsAppToken && trimmedAppToken
          ? { appToken: trimmedAppToken }
          : {}),
        ...(isDiscordCreate
          ? {
              discordApplicationId: String(
                discordBot?.applicationId || "",
              ).trim(),
              discordGuildMembersIntent:
                !!discordBot?.intents?.guildMembers,
            }
          : {}),
      });
      if (isTelegramCreate) {
        setTelegramCreated(true);
      } else if (isDiscordCreate) {
        setDiscordCreated(true);
      } else if (isSlackCreate) {
        setSlackCreated(true);
      } else if (!isEditMode) {
        onClose();
      }
    } catch {
      // The parent reports operation failures through its shared toast.
    }
  };

  return html`
    <${ModalShell}
      visible=${visible}
      onClose=${onClose}
      panelClassName="bg-modal border border-border rounded-xl p-6 max-w-lg w-full max-h-[calc(100vh-2rem)] overflow-y-auto space-y-4"
    >
      <${PageHeader}
        title=${telegramCreated
          ? "Telegram connected"
          : discordCreated
            ? "Discord connected"
            : slackCreated
              ? "Slack connected"
              : isEditMode
                ? "Edit Channel"
                : `Add ${getChannelMeta(provider).label || "Channel"} Channel`
        }
        actions=${html`
          <button
            type="button"
            onclick=${onClose}
            class="h-8 w-8 inline-flex items-center justify-center rounded-lg ac-btn-secondary"
            aria-label="Close modal"
          >
            <${CloseIcon} className="w-3.5 h-3.5 text-body" />
          </button>
        `}
      />

      ${telegramCreated
        ? html`<${TelegramChannelConnected}
            bot=${telegramBot}
            onDone=${onClose}
          />`
        : discordCreated
          ? html`<${DiscordChannelConnected}
              bot=${discordBot}
              onDone=${onClose}
            />`
          : slackCreated
            ? html`<${SlackChannelConnected}
                slack=${slackIdentity}
                onDone=${onClose}
              />`
            : html`<div class="space-y-3">
        ${isTelegramCreate
          ? html`<${TelegramChannelSetup}
              token=${token}
              bot=${telegramBot}
              verifying=${verifyingTelegram}
              verificationError=${telegramVerificationError}
              onTokenInput=${handleTelegramTokenInput}
              onVerify=${handleVerifyTelegram}
            />`
          : null}
        ${isDiscordCreate
          ? html`<${DiscordChannelSetup}
              token=${token}
              bot=${discordBot}
              verifying=${verifyingDiscord}
              verificationError=${discordVerificationError}
              onTokenInput=${handleDiscordTokenInput}
              onVerify=${handleVerifyDiscord}
            />`
          : null}
        ${isSlackCreate
          ? html`<${SlackChannelSetup}
              appName=${slackAppName}
              botToken=${token}
              appToken=${appToken}
              slack=${slackIdentity}
              verifying=${verifyingSlack}
              verificationError=${slackVerificationError}
              onAppNameInput=${setSlackAppName}
              onBotTokenInput=${handleSlackBotTokenInput}
              onAppTokenInput=${handleSlackAppTokenInput}
              onVerify=${handleVerifySlack}
            />`
          : null}
        ${!isGuidedBotCreate
          ? html`
        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">Name</span>
          <input
            type="text"
            value=${name}
            onInput=${(event) => {
              setNameEditedManually(true);
              setName(event.target.value);
            }}
            placeholder=${getChannelMeta(provider).label || "Channel"}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          />
        </label>

        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">Id</span>
          <input
            type="text"
            value=${accountId}
            readOnly=${true}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-fg-muted outline-none"
          />
          <p class="text-xs text-fg-muted">
            ${
              isEditMode
                ? "Channel id is fixed after creation."
                : isSingleAccountProvider
                  ? `${getChannelMeta(provider).label} supports one channel account and uses the default id.`
                  : providerHasAccounts
                    ? "Derived from the channel name."
                    : "First account uses the default id for this provider."
            }
          </p>
        </label>
        `
          : null}

        ${!isGuidedBotCreate
          ? html`<label class="block space-y-1">
          <span class="text-xs text-gray-400">
            ${isWhatsApp ? "Owner Number" : needsAppToken ? "Bot Token" : "Token"}
          </span>
          ${isWhatsApp
            ? html`
                <input
                  type="text"
                  value=${token}
                  onInput=${(event) => setToken(event.target.value)}
                  placeholder="+15551234567"
                  class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
                />
              `
            : html`
                <${SecretInput}
                  value=${token}
                  onInput=${(event) => setToken(event.target.value)}
                  placeholder=${token ? "" : "Paste bot token"}
                  loading=${loadingToken}
                  isSecret=${true}
                  inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
                />
              `}
          <p class="text-xs text-fg-muted">
            ${isWhatsApp
              ? "E.164 format phone number used for allowlist pairing."
              : html`Saved behind the scenes as
                <code class="font-mono text-fg-muted ml-1">${envKey || "CHANNEL_TOKEN"}</code>.`}
          </p>
        </label>`
          : null}

        ${
          needsAppToken && !isSlackCreate
            ? html`
                <label class="block space-y-1">
                  <span class="text-xs text-fg-muted"
                    >App Token (Socket Mode)</span
                  >
                  <${SecretInput}
                    value=${appToken}
                    onInput=${(event) => setAppToken(event.target.value)}
                    placeholder="xapp-..."
                    isSecret=${true}
                    inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
                  />
                  <p class="text-xs text-fg-muted">
                    Saved behind the scenes as
                    <code class="font-mono text-fg-muted ml-1">
                      ${extraEnvKey || kChannelExtraEnvKeys.slack}
                    </code>
                    .
                  </p>
                </label>
              `
            : null
        }

        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">
            ${isGuidedBotCreate ? "Connect this bot to" : "Agent"}
          </span>
          <select
            value=${agentId}
            onInput=${(event) => setAgentId(event.target.value)}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          >
            ${agents.map(
              (agent) => html`
                <option key=${agent.id} value=${agent.id}>
                  ${agent.name || agent.id}
                </option>
              `,
            )}
          </select>
          ${isGuidedBotCreate
            ? html`<p class="text-xs leading-5 text-fg-dim">
                Messages sent to this bot will go to the selected agent.
              </p>`
            : null}
        </label>

        ${
          !isEditMode && accountExists
            ? html`
                <p class="text-xs text-status-error-muted">
                  ${isSingleAccountProvider
                    ? `${getChannelMeta(provider).label} already has a configured channel account.`
                    : `A ${getChannelMeta(provider).label} account with this id already exists.`}
                </p>
              `
            : null
        }
        ${error ? html`<p class="text-xs text-status-error-muted">${error}</p>` : null}
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <${ActionButton}
          onClick=${onClose}
          disabled=${loading}
          loading=${false}
          tone="secondary"
          size="md"
          idleLabel="Cancel"
        />
        <${ActionButton}
          onClick=${handleSubmit}
          disabled=${loading || !canSubmit}
          loading=${loading}
          tone="primary"
          size="md"
          idleLabel=${isEditMode
            ? "Save Changes"
            : isTelegramCreate
              ? "Connect Telegram"
              : isDiscordCreate
                ? "Connect Discord"
                : isSlackCreate
                  ? "Connect Slack"
                  : "Create Channel"}
          loadingLabel=${isEditMode ? "Saving..." : createLoadingLabel}
        />
      </div>
      `}
    </${ModalShell}>
  `;
};
