import { h } from "preact";
import htm from "htm";
import { ToggleSwitch } from "../../toggle-switch.js";

const html = htm.bind(h);

const parseList = (value) =>
  Array.from(
    new Set(
      String(value || "")
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );

const listValue = (value) => (Array.isArray(value) ? value.join("\n") : "");

const TextList = ({ label, value, onChange, placeholder = "One id per line" }) => html`
  <label class="block space-y-1">
    <span class="text-xs text-fg-muted">${label}</span>
    <textarea
      rows="2"
      value=${listValue(value)}
      onInput=${(event) => onChange(parseList(event.target.value))}
      placeholder=${placeholder}
      class="w-full bg-field border border-border rounded-lg px-3 py-2 text-xs font-mono text-body outline-none focus:border-fg-muted resize-y"
    ></textarea>
  </label>
`;

export const ChannelPolicyEditor = ({
  provider = "",
  policy = {},
  agents = [],
  onChange = () => {},
}) => {
  const rooms = Array.isArray(policy.rooms) ? policy.rooms : [];
  const update = (patch) => onChange({ ...policy, ...patch });
  const updateRoom = (index, patch) =>
    update({
      rooms: rooms.map((room, roomIndex) =>
        roomIndex === index ? { ...room, ...patch } : room,
      ),
    });
  const addRoom = () =>
    update({
      rooms: [
        ...rooms,
        {
          id: "",
          ...(provider === "discord" ? { guildId: "", kind: "channel" } : {}),
          enabled: true,
          requireMention: true,
          users: [],
          roles: [],
          skills: [],
          routeAgentId: "",
        },
      ],
    });

  return html`
    <div class="border-t border-border pt-4 space-y-4">
      <div>
        <h3 class="text-sm font-medium text-body">Access policy</h3>
        <p class="text-xs text-fg-muted mt-1">
          Control who can reach this agent and when group messages activate it.
        </p>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">Direct messages</span>
          <select
            value=${policy.dmPolicy || "pairing"}
            onInput=${(event) => update({ dmPolicy: event.target.value })}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          >
            <option value="pairing">Pairing approval</option>
            <option value="allowlist">Allowlist only</option>
            <option value="open">Open</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">Groups and rooms</span>
          <select
            value=${policy.groupPolicy || "allowlist"}
            onInput=${(event) => update({ groupPolicy: event.target.value })}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          >
            <option value="allowlist">Configured rooms only</option>
            <option value="open">Open</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      <${TextList}
        label="Direct-message allowlist"
        value=${policy.allowFrom}
        onChange=${(allowFrom) => update({ allowFrom })}
        placeholder="User ids, one per line; use * only with Open"
      />
      ${provider === "telegram"
        ? html`<${TextList}
            label="Group sender allowlist"
            value=${policy.groupAllowFrom}
            onChange=${(groupAllowFrom) => update({ groupAllowFrom })}
          />`
        : null}
      ${provider === "discord" || provider === "slack"
        ? html`
            <label class="block space-y-1">
              <span class="text-xs text-fg-muted">Bot-authored messages</span>
              <select
                value=${String(policy.allowBots ?? "mentions")}
                onInput=${(event) => update({ allowBots: event.target.value })}
                class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
              >
                <option value="false">Ignore</option>
                <option value="mentions">Mentions only</option>
                <option value="true">Allow</option>
              </select>
            </label>
          `
        : null}
      <${ToggleSwitch}
        checked=${policy.requireMention !== false}
        label="Require a mention by default"
        onChange=${(requireMention) => update({ requireMention })}
      />

      <div class="border-t border-border pt-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="text-sm font-medium text-body">Room overrides</h4>
            <p class="text-xs text-fg-muted mt-1">
              Add a room id to control activation, senders, skills, or routing.
            </p>
          </div>
          <button type="button" class="ac-btn-secondary text-xs px-3 py-1.5 rounded-lg" onclick=${addRoom}>
            Add room
          </button>
        </div>
        ${rooms.map(
          (room, index) => html`
            <div key=${`${room.guildId || ""}:${room.id}:${index}`} class="ac-surface-inset rounded-lg p-3 space-y-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                ${provider === "discord" && room.kind === "channel"
                  ? html`<label class="block space-y-1">
                      <span class="text-xs text-fg-muted">Server id</span>
                      <input
                        value=${room.guildId || ""}
                        onInput=${(event) => updateRoom(index, { guildId: event.target.value })}
                        class="w-full bg-field border border-border rounded-lg px-3 py-2 text-xs font-mono text-body outline-none focus:border-fg-muted"
                      />
                    </label>`
                  : null}
                <label class="block space-y-1">
                  <span class="text-xs text-fg-muted">${provider === "telegram"
                    ? "Group id"
                    : provider === "discord" && room.kind === "guild"
                      ? "Server id"
                      : "Channel id"}</span>
                  <input
                    value=${room.id || ""}
                    onInput=${(event) => updateRoom(index, { id: event.target.value })}
                    class="w-full bg-field border border-border rounded-lg px-3 py-2 text-xs font-mono text-body outline-none focus:border-fg-muted"
                  />
                </label>
              </div>
              <div class="flex flex-wrap items-center gap-4">
                ${provider !== "discord" || room.kind === "channel"
                  ? html`<${ToggleSwitch}
                      checked=${room.enabled !== false}
                      label="Enabled"
                      onChange=${(enabled) => updateRoom(index, { enabled })}
                    />`
                  : null}
                <${ToggleSwitch}
                  checked=${room.requireMention !== false}
                  label="Require mention"
                  onChange=${(requireMention) => updateRoom(index, { requireMention })}
                />
              </div>
              <${TextList}
                label="Allowed users"
                value=${room.users}
                onChange=${(users) => updateRoom(index, { users })}
              />
              ${provider === "discord"
                ? html`<${TextList}
                    label="Allowed roles"
                    value=${room.roles}
                    onChange=${(roles) => updateRoom(index, { roles })}
                  />`
                : null}
              ${provider !== "discord" || room.kind === "channel"
                ? html`
                    <${TextList}
                      label="Skills available in this room"
                      value=${room.skills}
                      onChange=${(skills) => updateRoom(index, { skills })}
                      placeholder="Skill names, one per line; blank inherits"
                    />
                    <label class="block space-y-1">
                      <span class="text-xs text-fg-muted">Route this room to</span>
                      <select
                        value=${room.routeAgentId || ""}
                        onInput=${(event) => updateRoom(index, { routeAgentId: event.target.value })}
                        class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
                      >
                        <option value="">Use the channel account agent</option>
                        ${agents.map((agent) => html`<option value=${agent.id}>${agent.name || agent.id}</option>`)}
                      </select>
                    </label>
                  `
                : null}
              <div class="flex justify-end">
                <button
                  type="button"
                  class="ac-btn-danger text-xs px-3 py-1.5 rounded-lg"
                  onclick=${() => update({ rooms: rooms.filter((_, roomIndex) => roomIndex !== index) })}
                >
                  Remove room
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
};
