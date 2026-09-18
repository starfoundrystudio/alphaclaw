import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import { fetchAgentSkills } from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

export const AgentSkillsPanel = ({
  agent = {},
  saving = false,
  onUpdateAgent = async () => {},
}) => {
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const explicit = Array.isArray(agent.skills) ? agent.skills : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAgentSkills(agent.id)
      .then((payload) => {
        if (!cancelled) setCatalog(Array.isArray(payload?.skills) ? payload.skills : []);
      })
      .catch((error) => {
        if (!cancelled) showToast(error.message || "Could not load skills", "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.skills]);

  const selected = useMemo(
    () =>
      new Set(
        explicit ||
          catalog
            .filter((skill) => skill.eligible && !skill.blockedByAgentFilter)
            .map((skill) => skill.name),
      ),
    [catalog, explicit],
  );

  const setSkillEnabled = async (skillName, enabled) => {
    const next = new Set(selected);
    if (enabled) next.add(skillName);
    else next.delete(skillName);
    setUpdating(true);
    try {
      await onUpdateAgent(
        agent.id,
        { skills: Array.from(next) },
        "Agent skills updated",
      );
    } finally {
      setUpdating(false);
    }
  };

  const resetToDefaults = async () => {
    setUpdating(true);
    try {
      await onUpdateAgent(agent.id, { skills: null }, "Agent skills reset to defaults");
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return html`<div class="flex items-center gap-2 text-sm text-fg-muted py-6">
      <${LoadingSpinner} className="h-4 w-4" /> Loading OpenClaw skills...
    </div>`;
  }

  return html`
    <div class="space-y-4">
      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="card-label">Skills</h3>
            <p class="text-xs text-fg-muted mt-1">
              Choose which installed, eligible skills this agent can see.
            </p>
          </div>
          <div class="flex items-center gap-2">
            ${explicit === null ? html`<${Badge} tone="neutral">Inherited</${Badge}>` : null}
            ${explicit !== null
              ? html`<${ActionButton}
                  onClick=${resetToDefaults}
                  disabled=${saving || updating}
                  tone="secondary"
                  size="sm"
                  idleLabel="Use defaults"
                />`
              : null}
          </div>
        </div>
        ${catalog.length === 0
          ? html`<p class="text-xs text-fg-muted">No skills are installed for this agent.</p>`
          : html`<div class="divide-y divide-border">
              ${catalog.map((skill) => {
                const available = !!skill.eligible;
                return html`<div class="py-3 flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm text-body">${skill.emoji || ""} ${skill.name}</span>
                      ${available ? null : html`<${Badge} tone="warning">Unavailable</${Badge}>`}
                    </div>
                    ${skill.description
                      ? html`<p class="text-xs text-fg-muted mt-1">${skill.description}</p>`
                      : null}
                  </div>
                  <${ToggleSwitch}
                    checked=${selected.has(skill.name)}
                    disabled=${saving || updating || (!available && !selected.has(skill.name))}
                    label=""
                    onChange=${(enabled) => setSkillEnabled(skill.name, enabled)}
                  />
                </div>`;
              })}
            </div>`}
      </div>
    </div>
  `;
};
