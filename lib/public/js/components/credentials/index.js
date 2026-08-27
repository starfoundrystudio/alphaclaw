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
import { CredentialTable } from "./credential-table.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { PageHeader } from "../page-header.js";
import { PaneShell } from "../pane-shell.js";
import { PendingProposal } from "./pending-proposal.js";
import { ServiceTable } from "./service-table.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);
const kStatusCacheKey = "/api/agent-vault/status";
const kCredentialsCacheKey = "/api/agent-vault/credentials";
const kCredentialKeyPattern = /^[A-Z][A-Z0-9_]{1,127}$/;
const kServiceNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
const kSubstitutionModes = new Set([
  "query",
  "path",
  "header",
  "body",
  "websocket",
]);

const openExternal = (url) => {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
};

export const Credentials = ({ onRestartRequired = () => {} }) => {
  const [serviceName, setServiceName] = useState("");
  const [host, setHost] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [authMode, setAuthMode] = useState("bearer");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [apiKeyPrefix, setApiKeyPrefix] = useState("");
  const [requestInstructions, setRequestInstructions] = useState("");
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
  const credentialDetails = Array.isArray(
    credentialsPayload?.credentialDetails,
  )
    ? credentialsPayload.credentialDetails
    : credentials.map((credential) => ({
        key: String(credential || ""),
        vault: String(credentialsPayload?.vault || ""),
        status: "available",
        type: "",
        createdAt: "",
        updatedAt: "",
      }));
  const services = Array.isArray(credentialsPayload?.services)
    ? credentialsPayload.services
    : [];
  const normalizedServiceName = String(serviceName || "")
    .trim()
    .toLowerCase();
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedKey = String(key || "").trim().toUpperCase();
  const substitutionMode = kSubstitutionModes.has(authMode);
  const credentialPlaceholder = normalizedKey
    ? `__${normalizedKey.toLowerCase()}__`
    : "__credential_key__";
  const canCreate = useMemo(
    () =>
      status?.initialized === true &&
      kServiceNamePattern.test(normalizedServiceName) &&
      normalizedHost.length > 0 &&
      kCredentialKeyPattern.test(normalizedKey) &&
      String(description || "").trim().length > 0 &&
      String(reason || "").trim().length > 0 &&
      (authMode !== "api-key" || String(apiKeyHeader || "").trim().length > 0) &&
      (!substitutionMode ||
        String(requestInstructions || "").trim().length > 0),
    [
      apiKeyHeader,
      authMode,
      description,
      normalizedHost,
      normalizedKey,
      normalizedServiceName,
      reason,
      requestInstructions,
      status?.initialized,
      substitutionMode,
    ],
  );

  useEffect(() => {
    if (status?.restartRequired) onRestartRequired(true);
  }, [onRestartRequired, status?.restartRequired]);

  const handleCreateProposal = useCallback(async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const auth =
        authMode === "bearer"
          ? { type: "bearer", token: normalizedKey }
          : authMode === "api-key"
            ? {
                type: "api-key",
                key: normalizedKey,
                header: String(apiKeyHeader || "").trim(),
                ...(String(apiKeyPrefix || "")
                  ? { prefix: String(apiKeyPrefix) }
                  : {}),
              }
            : { type: "passthrough" };
      const result = await createAgentVaultProposal({
        service: {
          name: normalizedServiceName,
          host: normalizedHost,
          auth,
          ...(substitutionMode
            ? {
                substitutions: [
                  {
                    key: normalizedKey,
                    placeholder: credentialPlaceholder,
                    in: [authMode],
                  },
                ],
              }
            : {}),
        },
        credentials: [
          {
            key: normalizedKey,
            description: String(description || "").trim(),
          },
        ],
        reason: String(reason || "").trim(),
        ...(String(requestInstructions || "").trim()
          ? {
              requestInstructions: String(requestInstructions || "").trim(),
            }
          : {}),
      });
      if (result.status === "available") {
        showToast(`${normalizedServiceName} is already available`, "info");
      } else {
        setProposal(result.proposal);
        showToast("Service access proposal created", "success");
      }
      invalidateCache(kCredentialsCacheKey);
      await refreshCredentials({ force: true });
    } catch (error) {
      showToast(
        error.message || "Could not create service access proposal",
        "error",
      );
    } finally {
      setCreating(false);
    }
  }, [
    canCreate,
    creating,
    description,
    credentialPlaceholder,
    apiKeyHeader,
    apiKeyPrefix,
    authMode,
    normalizedHost,
    normalizedKey,
    normalizedServiceName,
    reason,
    requestInstructions,
    refreshCredentials,
    substitutionMode,
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
      <${PaneShell}
        header=${html`<${PageHeader} title="Agent Vault" />`}
      >
        <div class="flex min-h-48 items-center justify-center">
          <${LoadingSpinner} className="h-5 w-5" />
        </div>
      </${PaneShell}>
    `;
  }

  return html`
    <${PaneShell}
      header=${html`
        <${PageHeader}
          title="Agent Vault"
          actions=${html`
            <div class="flex items-center gap-2">
              ${status?.entryUrl
                ? html`
                    <${ActionButton}
                      tone="secondary"
                      size="sm"
                      idleLabel="Open console"
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
      `}
    >
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
              Credentials are brokered on the security gateway. Clawbridge
              displays only non-secret metadata.
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
            <${CredentialTable}
              credentials=${credentialDetails}
              vault=${credentialsPayload?.vault || "default"}
              loading=${credentialsLoading}
              error=${credentialsError}
            />
            <${ServiceTable} services=${services} />

            <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
              <div>
                <h2 class="text-sm font-semibold text-body">
                  Request service access
                </h2>
                <p class="mt-1 text-xs text-fg-muted">
                  One proposal configures the service rule and every missing
                  credential it references. Enter secret values only on the
                  Agent Vault approval page.
                </p>
              </div>
              <div class="grid gap-3">
                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="block">
                    <span class="text-xs text-fg-muted">Service name</span>
                    <input
                      class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                      value=${serviceName}
                      oninput=${(event) =>
                        setServiceName(event.currentTarget.value.toLowerCase())}
                      placeholder="openweathermap"
                      autocomplete="off"
                    />
                  </label>
                  <label class="block">
                    <span class="text-xs text-fg-muted">Host pattern</span>
                    <input
                      class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                      value=${host}
                      oninput=${(event) =>
                        setHost(event.currentTarget.value.toLowerCase())}
                      placeholder="api.openweathermap.org"
                      autocomplete="off"
                    />
                  </label>
                </div>
                <label class="block">
                  <span class="text-xs text-fg-muted">Credential key</span>
                  <input
                    class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                    value=${key}
                    oninput=${(event) =>
                      setKey(event.currentTarget.value.toUpperCase())}
                    placeholder="OPENWEATHER_API_KEY"
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
                    placeholder="OpenWeatherMap API credential"
                    autocomplete="off"
                  />
                </label>
                <label class="block">
                  <span class="text-xs text-fg-muted">
                    Credential injection
                  </span>
                  <select
                    class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body focus:border-fg-muted"
                    value=${authMode}
                    onchange=${(event) => setAuthMode(event.currentTarget.value)}
                  >
                    <option value="bearer">Authorization: Bearer header</option>
                    <option value="api-key">API key header</option>
                    <option value="query">Query placeholder</option>
                    <option value="path">URL path placeholder</option>
                    <option value="header">Custom header placeholder</option>
                    <option value="body">Request body placeholder</option>
                    <option value="websocket">WebSocket placeholder</option>
                  </select>
                </label>
                ${authMode === "api-key"
                  ? html`
                      <div class="grid gap-3 sm:grid-cols-2">
                        <label class="block">
                          <span class="text-xs text-fg-muted">Header name</span>
                          <input
                            class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                            value=${apiKeyHeader}
                            oninput=${(event) =>
                              setApiKeyHeader(event.currentTarget.value)}
                            placeholder="X-API-Key"
                            autocomplete="off"
                          />
                        </label>
                        <label class="block">
                          <span class="text-xs text-fg-muted">
                            Value prefix (optional)
                          </span>
                          <input
                            class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
                            value=${apiKeyPrefix}
                            oninput=${(event) =>
                              setApiKeyPrefix(event.currentTarget.value)}
                            placeholder="ApiKey "
                            autocomplete="off"
                          />
                        </label>
                      </div>
                    `
                  : null}
                ${substitutionMode
                  ? html`
                      <div class="ac-surface-inset rounded-lg p-3">
                        <p class="text-xs text-fg-muted">
                          Exact placeholder
                        </p>
                        <code class="mt-1 block text-xs text-body">
                          ${credentialPlaceholder}
                        </code>
                      </div>
                      <label class="block">
                        <span class="text-xs text-fg-muted">
                          Request instructions
                        </span>
                        <input
                          class="mt-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body focus:border-fg-muted"
                          value=${requestInstructions}
                          oninput=${(event) =>
                            setRequestInstructions(event.currentTarget.value)}
                          placeholder=${authMode === "query"
                            ? `Set the appid query parameter to ${credentialPlaceholder}`
                            : `Place ${credentialPlaceholder} in the ${authMode}`}
                          autocomplete="off"
                        />
                        <p class="mt-1 text-[11px] text-fg-dim">
                          These instructions are returned to the agent after
                          approval so it uses the exact placeholder correctly.
                        </p>
                      </label>
                    `
                  : null}
                <label class="block">
                  <span class="text-xs text-fg-muted">Why it is needed</span>
                  <textarea
                    class="mt-1 min-h-20 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body focus:border-fg-muted"
                    value=${reason}
                    oninput=${(event) => setReason(event.currentTarget.value)}
                    placeholder="Needed to call the upstream API for the current task"
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
              <${PendingProposal}
                proposal=${proposal}
                onOpen=${() => openExternal(proposal?.approvalUrl)}
              />
            </section>
          `
        : null}
    </${PaneShell}>
  `;
};
