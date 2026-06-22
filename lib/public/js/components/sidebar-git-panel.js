import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import {
  configureGithubSync,
  fetchBrowseGitSummary,
  syncBrowseChanges,
} from "../lib/api.js";
import { formatLocaleDateTime } from "../lib/format.js";
import { ActionButton } from "./action-button.js";
import { GitBranchLineIcon, GithubFillIcon } from "./icons.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { ModalShell } from "./modal-shell.js";
import { SecretInput } from "./secret-input.js";
import { showToast } from "./toast.js";

const html = htm.bind(h);
const kRefreshMs = 10000;
const kSyncCommitFileNameLimit = 4;
const kCommitHistoryLimit = 12;
const kDefaultSyncSchedule = "0 * * * *";

const formatCommitTime = (unixSeconds) => {
  return formatLocaleDateTime(unixSeconds, {
    fallback: "",
    valueIsUnixSeconds: true,
  });
};

const getRepoName = (summary) => {
  const slug = String(summary?.repoSlug || "").trim();
  if (slug) return slug;
  const pathValue = String(summary?.repoPath || "");
  const segment = pathValue.split("/").filter(Boolean).pop();
  return segment || "repo";
};

const getChangedFilePresentation = (changedFile) => {
  const statusKind = String(changedFile?.statusKind || "M").toUpperCase();
  if (statusKind === "U") {
    return {
      statusLabel: "U",
      statusClass: "is-untracked",
      rowClass: "is-clickable",
      canOpen: true,
    };
  }
  if (statusKind === "D") {
    return {
      statusLabel: "D",
      statusClass: "is-deleted",
      rowClass: "is-clickable",
      canOpen: true,
    };
  }
  return {
    statusLabel: "M",
    statusClass: "is-modified",
    rowClass: "is-clickable",
    canOpen: true,
  };
};

const formatDelta = (value, prefix) => {
  if (value === null || value === undefined || value === "") return "";
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return "";
  return `${prefix}${numericValue}`;
};

const isDirectoryChangePath = (changedPath, statusKind) => {
  const safePath = String(changedPath || "").trim();
  const safeStatusKind = String(statusKind || "").toUpperCase();
  if (!safePath) return false;
  if (safePath.endsWith("/")) return true;
  return safeStatusKind === "U" && safePath.endsWith("\\");
};

const getRemoteSyncPresentation = (summary) => {
  const safeState = String(summary?.syncState || "").trim();
  const aheadCount = Number(summary?.aheadCount) || 0;
  const behindCount = Number(summary?.behindCount) || 0;
  if (safeState === "ahead") {
    return {
      label: "↑",
      title: `Ahead by ${aheadCount}`,
      className: "is-ahead",
    };
  }
  if (safeState === "behind") {
    return {
      label: "↓",
      title: `Behind by ${behindCount}`,
      className: "is-behind",
    };
  }
  if (safeState === "diverged") {
    return {
      label: "↕",
      title: `Diverged (${aheadCount} ahead, ${behindCount} behind)`,
      className: "is-diverged",
    };
  }
  if (safeState === "upstream-gone") {
    return {
      label: "!",
      title: "Upstream missing",
      className: "is-upstream-gone",
    };
  }
  if (safeState === "no-upstream" || !summary?.hasUpstream) {
    return {
      label: "!",
      title: "Not linked",
      className: "is-no-upstream",
    };
  }
  return {
    label: "",
    title: "Up to date",
    className: "is-up-to-date",
  };
};

const buildSyncCommitMessage = (summary) => {
  const changedFiles = Array.isArray(summary?.changedFiles) ? summary.changedFiles : [];
  const changedFilesCount = Number(summary?.changedFilesCount) || 0;
  const filePaths = changedFiles
    .map((file) => String(file?.path || "").trim())
    .filter(Boolean);
  const totalCount = changedFilesCount || filePaths.length;
  if (totalCount <= 0) return "sync changes";

  const fileNames = filePaths
    .map((filePath) => filePath.split("/").filter(Boolean).pop() || filePath);
  const uniqueFileNames = Array.from(new Set(fileNames));
  if (uniqueFileNames.length <= 0) {
    const noun = totalCount === 1 ? "file" : "files";
    return `Edited ${totalCount} ${noun}`;
  }

  const shownFileNames = uniqueFileNames.slice(0, kSyncCommitFileNameLimit);
  const remainingCount = Math.max(0, totalCount - shownFileNames.length);
  const noun = totalCount === 1 ? "file" : "files";
  const suffix = remainingCount > 0 ? ` +${remainingCount} more` : "";
  return `Edited ${totalCount} ${noun} - ${shownFileNames.join(", ")}${suffix}`;
};

export const SidebarGitPanel = ({
  onSelectFile = () => {},
  isActive = true,
}) => {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupRepo, setSetupRepo] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupSchedule, setSetupSchedule] = useState(kDefaultSyncSchedule);
  const [setupSaving, setSetupSaving] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (!isActive) return () => {};
    let active = true;
    let intervalId = null;

    const loadSummary = async () => {
      if (!active) return;
      try {
        const data = await fetchBrowseGitSummary();
        if (!active) return;
        setSummary(data);
        setError("");
      } catch (nextError) {
        if (!active) return;
        setError(nextError.message || "Could not load git summary");
      } finally {
        if (active) setLoading(false);
      }
    };

    const handleFileSaved = () => {
      loadSummary();
    };

    loadSummary();
    intervalId = window.setInterval(loadSummary, kRefreshMs);
    window.addEventListener("alphaclaw:browse-file-saved", handleFileSaved);

    return () => {
      active = false;
      if (intervalId) window.clearInterval(intervalId);
      window.removeEventListener("alphaclaw:browse-file-saved", handleFileSaved);
    };
  }, [isActive]);

  if (loading) {
    return html`
      <div class="sidebar-git-panel sidebar-git-loading" aria-label="Loading git summary">
        <${LoadingSpinner} className="h-4 w-4" />
      </div>
    `;
  }

  if (error) {
    return html`<div class="sidebar-git-panel sidebar-git-panel-error">${error}</div>`;
  }

  if (!summary?.isRepo) {
    return html`
      <div class="sidebar-git-panel">
        <div class="sidebar-git-meta">No git repo at this root</div>
      </div>
    `;
  }

  const hasUncommittedChanges = (summary.changedFiles || []).length > 0;
  const aheadCount = Number(summary?.aheadCount) || 0;
  const hasGithubSyncTarget =
    !!String(summary?.repoSlug || "").trim() ||
    !!String(summary?.repoUrl || "").trim();
  const canSyncChanges = hasGithubSyncTarget && (hasUncommittedChanges || aheadCount > 0);
  const canSetupGithubSync =
    !hasGithubSyncTarget;
  const canSaveGithubSync =
    String(setupRepo || "").trim() &&
    String(setupToken || "").trim() &&
    !setupSaving;
  const remoteSync = getRemoteSyncPresentation(summary);
  const refreshSummary = async () => {
    const nextSummary = await fetchBrowseGitSummary();
    setSummary(nextSummary);
    setError("");
    return nextSummary;
  };
  const handleSyncChanges = async () => {
    if (!canSyncChanges || syncing) return;
    try {
      setSyncing(true);
      const commitMessage = buildSyncCommitMessage(summary);
      const syncResult = await syncBrowseChanges(commitMessage);
      if (syncResult?.committed || syncResult?.pushed) {
        window.dispatchEvent(new CustomEvent("alphaclaw:browse-git-synced"));
        showToast(syncResult.message || "Changes synced", "success");
      } else {
        showToast(syncResult?.message || "No changes to sync", "info");
      }
      await refreshSummary();
    } catch (syncError) {
      showToast(syncError.message || "Could not sync changes", "error");
    } finally {
      setSyncing(false);
    }
  };
  const handleSetupGithubSync = async () => {
    if (!canSaveGithubSync) return;
    setSetupSaving(true);
    try {
      const result = await configureGithubSync({
        repo: setupRepo,
        token: setupToken,
        schedule: setupSchedule,
      });
      if (!result.ok) {
        throw new Error(result.error || "Could not configure GitHub sync");
      }
      showToast("GitHub sync configured", "success");
      setSetupOpen(false);
      setSetupToken("");
      await refreshSummary();
    } catch (setupError) {
      showToast(setupError.message || "Could not configure GitHub sync", "error");
    } finally {
      setSetupSaving(false);
    }
  };

  return html`
    <div class="sidebar-git-panel">
      <div class="sidebar-git-bar">
        ${summary.repoUrl
          ? html`
              <a
                class="sidebar-git-bar-main sidebar-git-link"
                href=${summary.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                title=${summary.repoUrl}
              >
                <${GithubFillIcon} className="sidebar-git-bar-icon" />
                <span class="sidebar-git-repo-name">${getRepoName(summary)}</span>
              </a>
            `
          : html`
              <span class="sidebar-git-bar-main">
                <${GithubFillIcon} className="sidebar-git-bar-icon" />
                <span class="sidebar-git-repo-name">${getRepoName(summary)}</span>
              </span>
            `}
      </div>
      <div class="sidebar-git-bar sidebar-git-bar-secondary">
        <span class="sidebar-git-bar-main">
          <${GitBranchLineIcon} className="sidebar-git-bar-icon" />
          <span class="sidebar-git-branch">${summary.branch || "unknown"}</span>
        </span>
        ${remoteSync.label
          ? html`
              <span
                class=${`sidebar-git-sync-status ${remoteSync.className}`.trim()}
                title=${remoteSync.title || ""}
                aria-label=${remoteSync.title || ""}
              >
                ${remoteSync.label}
              </span>
            `
          : null}
      </div>
      ${canSetupGithubSync
        ? html`
            <div class="sidebar-git-actions">
              <${ActionButton}
                onClick=${() => setSetupOpen(true)}
                idleLabel="Setup Github Sync"
                tone="secondary"
                size="sm"
                className="sidebar-git-sync-button"
              />
            </div>
          `
        : null}
      <div class="sidebar-git-scroll">
        ${(summary.changedFiles || []).length > 0
          ? html`
              <div class="sidebar-git-changes-label">
                ${`${hasGithubSyncTarget ? "Unsynced" : "Local"} Changes (${summary.changedFilesCount || (summary.changedFiles || []).length})`}
              </div>
              <ul class="sidebar-git-changes-list">
                ${(summary.changedFiles || []).map((changedFile) => {
                  const presentation = getChangedFilePresentation(changedFile);
                  const changedPath = String(changedFile?.path || "");
                  const plusDelta = formatDelta(changedFile?.addedLines, "+");
                  const minusDelta = formatDelta(changedFile?.deletedLines, "-");
                  return html`
                    <li
                      class=${`sidebar-git-change-row ${presentation.statusClass} ${presentation.rowClass}`.trim()}
                      title=${changedPath}
                      onclick=${() => {
                        if (!presentation.canOpen || !changedPath) return;
                        const directorySelection = isDirectoryChangePath(
                          changedPath,
                          changedFile?.statusKind,
                        );
                        if (directorySelection) {
                          onSelectFile(changedPath, {
                            directory: true,
                            preservePreview: true,
                          });
                          return;
                        }
                        onSelectFile(changedPath, { view: "diff" });
                      }}
                    >
                      <span class="sidebar-git-change-path">${changedPath}</span>
                      <span class="sidebar-git-change-meta">
                        ${plusDelta
                          ? html`<span class="sidebar-git-change-plus">${plusDelta}</span>`
                          : null}
                        ${minusDelta
                          ? html`<span class="sidebar-git-change-minus">${minusDelta}</span>`
                          : null}
                        <span class="sidebar-git-change-status">${presentation.statusLabel}</span>
                      </span>
                    </li>
                  `;
                })}
              </ul>
              ${hasGithubSyncTarget
                ? html`
                    <div class="sidebar-git-actions">
                      <${ActionButton}
                        onClick=${handleSyncChanges}
                        disabled=${!canSyncChanges}
                        loading=${syncing}
                        loadingMode="inline"
                        idleLabel="Sync Changes"
                        loadingLabel="Syncing..."
                        tone="primary"
                        size="sm"
                        className="sidebar-git-sync-button"
                      />
                    </div>
                  `
                : null}
            `
          : null}
        ${(summary.commits || []).length > 0
          ? html`
              <div class="sidebar-git-changes-label">commit history</div>
              <ul class="sidebar-git-list">
                ${(summary.commits || []).slice(0, kCommitHistoryLimit).map(
                  (commit) => html`
                    <li title=${formatCommitTime(commit.timestamp)}>
                      ${commit.url
                        ? html`
                            <a
                              class="sidebar-git-commit-link"
                              href=${commit.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <span class="sidebar-git-hash">${commit.shortHash}</span>
                              <span>${commit.message}</span>
                            </a>
                          `
                        : html`
                            <span class="sidebar-git-hash">${commit.shortHash}</span>
                            <span>${commit.message}</span>
                          `}
                    </li>
                  `,
                )}
              </ul>
            `
          : null}
      </div>
      <${ModalShell}
        visible=${setupOpen}
        onClose=${() => {
          if (setupSaving) return;
          setSetupOpen(false);
        }}
        closeOnOverlayClick=${!setupSaving}
        closeOnEscape=${!setupSaving}
        panelClassName="bg-modal border border-border rounded-xl p-5 max-w-md w-full space-y-4"
      >
        <div>
          <h2 class="text-sm font-semibold text-body">Setup Github Sync</h2>
          <p class="mt-1 text-xs text-fg-muted">
            Add a backup repo for workspace and config changes.
          </p>
        </div>
        <div class="space-y-1">
          <label class="text-xs font-medium text-fg-muted">Workspace Repo</label>
          <input
            type="text"
            value=${setupRepo}
            onInput=${(event) => setSetupRepo(event.target.value)}
            placeholder="owner/repo"
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
          />
          <p class="text-xs text-fg-dim">
            AlphaClaw can create a private repo, or use an existing empty repo.
          </p>
        </div>
        <div class="space-y-1">
          <label class="text-xs font-medium text-fg-muted"
            >Personal Access Token</label
          >
          <${SecretInput}
            value=${setupToken}
            onInput=${(event) => setSetupToken(event.target.value)}
            placeholder="ghp_... or github_pat_..."
            isSecret=${true}
            inputClass="flex-1 bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
          />
          <p class="text-xs text-fg-dim">
            Use a classic PAT with${" "}
            <code class="text-xs bg-field px-1 rounded">repo</code>${" "}
            scope, or a fine-grained token with Contents + Metadata access.
          </p>
        </div>
        <div class="space-y-1">
          <label class="text-xs font-medium text-fg-muted">Auto-sync</label>
          <select
            value=${setupSchedule}
            onChange=${(event) => setSetupSchedule(event.target.value)}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          >
            <option value="*/30 * * * *">Every 30 min</option>
            <option value="0 * * * *">Hourly</option>
            <option value="0 0 * * *">Daily</option>
          </select>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <${ActionButton}
            onClick=${() => setSetupOpen(false)}
            disabled=${setupSaving}
            idleLabel="Cancel"
            tone="secondary"
            size="sm"
          />
          <${ActionButton}
            onClick=${handleSetupGithubSync}
            disabled=${!canSaveGithubSync}
            loading=${setupSaving}
            idleLabel="Save"
            loadingLabel="Saving..."
            tone="primary"
            size="sm"
          />
        </div>
      </${ModalShell}>
    </div>
  `;
};
