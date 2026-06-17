import { h } from "preact";
import htm from "htm";
import { DashboardLineIcon } from "./icons.js";

const html = htm.bind(h);

export const SidebarDashboardAction = ({
  hasPending = false,
  loading = false,
  onOpen = () => {},
}) => html`
  <div class="sidebar-dashboard-action-wrap">
    <button
      type="button"
      class=${`sidebar-dashboard-action ${hasPending ? "has-pending" : ""}`}
      onclick=${onOpen}
      aria-label=${hasPending
        ? "Open OpenClaw dashboard, browser approval pending"
        : "Open OpenClaw dashboard"}
    >
      <span class="sidebar-dashboard-icon-shell">
        <${DashboardLineIcon} className="sidebar-dashboard-icon" />
      </span>
      <span class="sidebar-dashboard-copy">
        <span class="sidebar-dashboard-title">Open OpenClaw</span>
        <span class="sidebar-dashboard-subtitle">
          ${hasPending
            ? "Browser approval pending"
            : loading
              ? "Checking access..."
              : "Dashboard and chat UI"}
        </span>
      </span>
      ${hasPending ? html`<span class="sidebar-dashboard-dot" aria-hidden="true"></span>` : null}
    </button>
  </div>
`;
