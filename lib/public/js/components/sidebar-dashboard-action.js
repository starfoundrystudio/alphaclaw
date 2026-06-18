import { h } from "preact";
import htm from "htm";
import { OpenClawLogoIcon } from "./icons.js";

const html = htm.bind(h);

export const SidebarDashboardAction = ({
  hasPending = false,
  onOpen = () => {},
}) => html`
  <div class="sidebar-dashboard-action-wrap">
    <button
      type="button"
      class=${`sidebar-dashboard-action ${hasPending ? "has-pending" : ""}`}
      onclick=${onOpen}
      aria-label=${hasPending
        ? "Launch OpenClaw, browser approval pending"
        : "Launch OpenClaw"}
    >
      <span class="sidebar-dashboard-icon-shell">
        <${OpenClawLogoIcon} className="sidebar-dashboard-icon" />
      </span>
      <span class="sidebar-dashboard-copy">
        <span class="sidebar-dashboard-title">Launch OpenClaw</span>
      </span>
      ${hasPending ? html`<span class="sidebar-dashboard-dot" aria-hidden="true"></span>` : null}
    </button>
  </div>
`;
