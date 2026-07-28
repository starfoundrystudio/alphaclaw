import { h } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import {
  createAgentVaultProposal,
  fetchAgentVaultCredentials,
  fetchAgentVaultStatus,
} from "../../lib/api.js";
import { invalidateCache } from "../../lib/api-cache.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { PageHeader } from "../page-header.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);
const kStatusCacheKey = "/api/agent-vault/status";
const kCredentialsCacheKey = "/api/agent-vault/credentials";
const kCredentialKeyPattern = /^[A-Z][A-Z0-9_]{1,127}$/;

const openExternal = (url) => {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
};

export const Credentials = ({ onRestartRequired = () => {} }) => {
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [proposal, setProposal] = useState(null);
  const {
    data: statusPayload,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useCachedFetch(kStatusCacheKey, fetchAgentVaultStatus, {
    maxAgeMs: 5000,
    staleWhileRevalidate: false,
  });
  const status = statusPayload?.status || null;
  const {
    data: credentialsPayload,
    loading: credentialsLoading,
    error: credentialsError,
    refresh: refreshCredentials,
  } = useCachedFetch(kCredentialsCacheKey, fetchAgentVaultCredentials, {
    enabled: status?.initialized === true,
    maxAgeMs: 5000,
    staleWhileRevalidate: false,
  });
  const credentials = Array.isArray(credentialsPayload?.credentials)
    ? credentialsPayload.credentials
    : [];
  const normalizedKey = String(key || "").trim().toUpperCase();
  const canCreate = useMemo(
    () =>
      status?.initialized === true &&
      kCredentialKeyPattern.test(normalizedKey) &&
      String(description || "").trim().length > 0 &&
      String(reason || "").trim().length > 0,
    [description, normalizedKey, reason, status?.initialized],
  );

  useEffect(() => {
    if (status?.restartRequired) onRestartRequired(true);
  }, [onRestartRequired, status?.restartRequired]);

  const handleCreateProposal = useCallback(async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const result = await createAgentVaultProposal({
        key: normalizedKey,
        description: String(description || "").trim(),
        reason: String(reason || "").trim(),
      });
      if (result.status === "available") {
        showToast(`${normalizedKey} is already available`, "info");
      } else {
        setProposal(result.proposal);
        showToast("Credential proposal created", "success");
      }
      invalidateCache(kCredentialsCacheKey);
      await refreshCredentials({ force: true });
    } catch (error) {
      showToast(error.message || "Could not create credential proposal", "error");
    } finally {
      setCreating(false);
    }
  }, [
    canCreate,
    creating,
    description,
    normalizedKey,
    reason,
    refreshCredentials,
  ]);

  const handleRefresh = useCallback(async () => {
    invalidateCache(kStatusCacheKey);
    invalidateCache(kCredentialsCacheKey);
    const next = await refreshStatus({ force: true }).catch(() => null);
    if (next?.status?.restartRequired) onRestartRequired(true);
    if (next?.status?.initialized) {
      await refreshCredentials({ force: true }).catch(() => {});
    }
  }, [onRestartRequired, refreshCredentials, refreshStatus]);

  if (statusLoading && !status) {
    return html`
      <div class="flex min-h-48 items-center justify-center">
        <${LoadingSpinner} className="h-5 w-5" />
      </div>
    `;
  }

  return html`
    <div class="space-y-4">
      <${PageHeader}
        title="Credentials"
        actions=${html`
          <div class="flex items-center gap-2">
            ${status?.entryUrl
              ? html`
                  <${ActionButton}
                    tone="secondary"
                    size="sm"
                    idleLabel="Open Agent Vault"
                    onClick=${() => openExternal(status.entryUrl)}
                  />
                `
              : null}
            <${ActionButton}
              tone="primary"
              size="sm"
              idleLabel="Refresh"
              onClick=${handleRefresh}
            />
          </div>
        `}
      />

      ${statusError
        ? html`
            <div class="rounded-xl border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-muted">
              ${statusError.message || "Agent Vault status is unavailable."}
            </div>
          `
        : null}

      <section class="bg-surface border border-border rounded-xl p-5 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold text-body">Agent Vault</h2>
            <p class="mt-1 text-xs text-fg-muted">
              Credentials are brokered on the security gateway. AlphaClaw only
              displays their names.
            </p>
          </div>
          <${Badge}
            tone=${status?.connected
              ? "success"
              : status?.initialized
                ? "warning"
                : "neutral"}
          >
            ${status?.connected
              ? "Connected"
              : status?.initialized
                ? "Unavailable"
                : status?.ownerEnrollmentPending
                  ? "Owner setup required"
                  : "Disabled"}
          </${Badge}>
        </div>
        ${status?.ownerEnrollmentPending
          ? html`
              <div class="ac-surface-inset rounded-lg p-3 text-xs text-fg-muted">
                Open Agent Vault from your TeamYou instance card to verify your
                identity. TeamYou creates the owner session without a separate
                Agent Vault password.
              </div>
            `
          : null}
        ${status?.warning
          ? html`<p class="text-xs text-status-warning-muted">${status.warning}</p>`
          : null}
      </section>

      ${status?.initialized
        ? html`
            <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
              <div>
                <h2 class="text-sm font-semibold text-body">Available keys</h2>
                <p class="mt-1 text-xs text-fg-muted">
                  Values never leave Agent Vault and are never returned here.
                </p>
              </div>
              ${credentialsLoading
                ? html`<${LoadingSpinner} className="h-4 w-4" />`
                : credentialsError
                  ? html`
                      <p class="text-xs text-status-error-muted">
                        ${credentialsError.message || "Could not load credentials."}
                      </p>
                    `
                  : credentials.length
                    ? html`
                        <div class="flex flex-wrap gap-2">
                          ${credentials.map(
                            (credential) => html`
                              <code
                                key=${credential}
                                class="rounded-lg border border-border bg-field px-2.5 py-1.5 text-xs text-body"
                              >
                                ${credential}
                              </code>
                            `,
                          )}
                        </div>
                      `
                    : html`
                        <p class="text-xs text-fg-muted">
                          No credential values have been defined yet.
                        </p>
                      `}
            </section>

            <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
              <div>
                <h2 class="text-sm font-semibold text-body">
                  Request a credential
                </h2>
                <p class="mt-1 text-xs text-fg-muted">
                  This creates a value-less proposal. Enter the secret only on
                  the Agent Vault approval page.
                </p>
              </div>
              <div class="grid gap-3">
                <label class="block">
                  <span class="text-xs text-fg-muted">Key</span>
                  <input
                    class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                    value=${key}
                    oninput=${(event) =>
                      setKey(event.currentTarget.value.toUpperCase())}
                    placeholder="STRIPE_API_KEY"
                    autocomplete="off"
                  />
                </label>
                <label class="block">
                  <span class="text-xs text-fg-muted">Description</span>
                  <input
                    class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body focus:border-fg-muted"
                    value=${description}
                    oninput=${(event) =>
                      setDescription(event.currentTarget.value)}
                    placeholder="Stripe API credential"
                    autocomplete="off"
                  />
                </label>
                <label class="block">
                  <span class="text-xs text-fg-muted">Why it is needed</span>
                  <textarea
                    class="mt-1 min-h-20 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body focus:border-fg-muted"
                    value=${reason}
                    oninput=${(event) => setReason(event.currentTarget.value)}
                    placeholder="Needed to create invoices for the current task"
                  ></textarea>
                </label>
              </div>
              <${ActionButton}
                tone="primary"
                size="sm"
                idleLabel="Create proposal"
                loadingLabel="Creating..."
                loading=${creating}
                disabled=${!canCreate}
                onClick=${handleCreateProposal}
              />
              ${proposal?.approvalUrl
                ? html`
                    <div class="ac-surface-inset rounded-lg p-3">
                      <p class="text-xs text-fg-muted">
                        Proposal #${proposal.id} is waiting for approval.
                      </p>
                      <button
                        class="ac-tip-link mt-2 text-xs"
                        onclick=${() => openExternal(proposal.approvalUrl)}
                      >
                        Open approval page
                      </button>
                    </div>
                  `
                : null}
            </section>
          `
        : null}
    </div>
  `;
};
