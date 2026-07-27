# AlphaClaw Design Guidelines

AlphaClaw follows the **TeamYou design system**. This document ports TeamYou's
`DESIGN.md` to AlphaClaw's stack and token vocabulary — written for humans and
AI agents working on the UI in `lib/public/`.

> **Provenance:** brand values (palettes, status semantics, typography) are
> mirrored from the teamyou repo's `DESIGN.md` (as of teamyou commit
> `1e4783b3`, 2026-07). TeamYou is the source of truth for brand constants;
> when the brand changes there, sync the palette tables here, the scales in
> `tailwind.config.cjs`, and the variables in `lib/public/css/theme.css`.

It describes the **desired state**. The token layer (`theme.css`, fonts,
Tailwind scales) has been remapped; component markup is still being migrated —
see [Migration status](#migration-status). When you touch legacy markup, move
it toward this document; never copy the legacy pattern forward.

---

## Design like TeamYou

AlphaClaw is the setup UI and gateway manager for OpenClaw — an operator's
console. It should feel like a **calm, trustworthy workspace**, not a sci-fi
terminal.

- **Calm surfaces, one loud color.** Neutral (light) or deep cobalt (dark)
  surfaces everywhere; TeamYou Green is the single brand accent, reserved for
  identity and primary actions. If everything is green, nothing is.
- **Dark mode is a cobalt environment, not gray-on-black.** Surfaces come from
  the teamyou-cobalt scale with their own hierarchy (sidebar darkest → app
  background → content panels).
- **Rhythm over decoration.** Quality comes from consistent spacing, aligned
  type, and restrained borders — not glows, gradients, or grid textures.
- **One way to render each concept.** One primary-button treatment, one status
  badge treatment, one panel treatment. Consolidate divergent variants.
- **Tokens, not literals.** All color flows through the CSS variables in
  `theme.css` (or the brand scales in `tailwind.config.cjs`). New hardcoded
  hex/rgba values in components or CSS are bugs.

## Priority order

When rules conflict: **1)** accessibility and legibility (contrast, focus
states) → **2)** theme variables over raw palette classes over hex literals →
**3)** existing shared treatments (`ac-*` classes) before new ones → **4)** the
color and spacing rules in this document → **5)** local polish.

---

## Color

### Brand palettes

Defined as Tailwind scales in `tailwind.config.cjs` (`teamyou-green-*`,
`teamyou-cobalt-*`), mirroring TeamYou.

**TeamYou Green** — the brand accent. Identity, primary actions, success.

| Shade   | Hex       | Typical use                                  |
| ------- | --------- | -------------------------------------------- |
| 100–200 | `#d8ffea` – `#b4fed5` | light soft fills; dark hover text |
| 300     | `#7afbb5` | dark-mode links (`--accent-link`), success text |
| **400** | **`#31ee88`** | **dark `--accent`, primary CTA, logo mark** |
| 500     | `#10d76c` | CTA hover                                    |
| 600–700 | `#06b357` – `#098c47` | light-mode `--accent` / `--accent-link` (green text on white) |
| 950     | `#00331a` | dark success surface                         |

**TeamYou Cobalt** — the dark-mode surface family plus informational accents.

| Shade | Hex       | Typical use                                   |
| ----- | --------- | --------------------------------------------- |
| 100–300 | `#cce5f1` – `#66b1d5` | light info surfaces/borders     |
| 400–600 | `#3397c7` – `#006494` | info text, hover tints, borders |
| 700   | `#004b6f` | dark `--border-strong`, field borders         |
| 800   | `#023544` | dark `--border`                               |
| 900   | `#012a3a` | dark info surface                             |
| 950   | `#000d15` | dark sidebar (`--bg-sidebar`), menus          |

### Theme variables (the API components use)

All component color goes through `lib/public/css/theme.css` variables. The
mapping to TeamYou:

| Variable | Dark | Light | TeamYou equivalent |
| -------- | ---- | ----- | ------------------ |
| `--bg` | `#00141f` | `#ffffff` | `--background` |
| `--bg-sidebar` | `#000d15` (cobalt-950) | `#fafafa` | `--sidebar-background` |
| `--bg-content` | `#001f2d` | `#ffffff` | popover / brand `cobaltSurface` |
| `--bg-hover` | cobalt-400 @ 8% | black @ 4% | hover surface (cobalt, **not** green) |
| `--bg-active` | green-400 @ 8% | green-500 @ 10% | selected state (pairs with accent text) |
| `--border` / `--border-strong` | cobalt-800 / 700 | `#e4e4e7` / `#d4d4d8` | `--border` |
| `--text` / `--text-muted` | `#d4d4d8` / `#a0aec0` | `#18181b` / `#71717a` | foreground / muted-foreground |
| `--accent` | green-400 | green-600 | brand accent |
| `--accent-link` | green-300 | green-700 | links |
| `--orange` | orange-400 | orange-600 | TeamYou `caution` |
| `--field-bg-contrast` | `#001f2d` | black @ 4% | input background |

Zinc/gray **text** values are fine; zinc/gray **backgrounds and borders** are
not — surfaces and borders come from the cobalt family (dark) or the neutral
zinc-200-range values above (light).

### Status colors

Four families, same semantics as TeamYou (`--status-{error|warning|success|info}-{,-muted,-bg,-border}`):

- **error** — red. Failures, destructive confirmation.
- **warning** — **amber** (TeamYou `warning`): soft warnings, quotas,
  recoverable errors. Never yellow-green.
- **success** — **teamyou-green**: healthy, connected, complete.
- **info** — **teamyou-cobalt**: neutral information, in-progress.

Never invent new status hues; route new meanings through these four.

---

## Typography

- **Geist** (sans) for all UI text; **Geist Mono** for code, logs, paths,
  tokens, and terminal content. Both load from Google Fonts in `setup.html` /
  `login.html`. The xterm terminal keeps a system monospace stack.
- Base body size is 13px (dense operator console; TeamYou proper uses 14px —
  acceptable divergence for this surface).
- Headings are sentence case, weight 500–600. The legacy uppercase
  letter-spaced label style (`.ac-small-heading`) is deprecated — prefer
  sentence-case muted labels as markup is migrated.
- Emphasis via weight and `--text-muted` → `--text` → `--text-bright` steps,
  not size jumps.

---

## Spacing, radius, and surfaces

- Panels and cards: `8px` radius standard (`10px` legacy values are being
  normalized down); pills and toggles `999px`.
- One panel treatment: `--panel-bg-contrast` + `--panel-border-contrast`
  (via `.bg-surface` / `.ac-surface-inset`). Don't stack panels-on-panels more
  than one level deep.
- Spacing rhythm: 8px within a group, 16px between groups, 24px between
  page sections. Don't invent new gaps.
- Modals use `.bg-modal` (solid `--bg`) so content never bleeds through.

---

## Components

Shared treatments live in `theme.css` (`ac-*` classes) and
`lib/public/js/components/`. Use them; don't hand-roll parallels.

### Buttons

- **Primary / brand action** (create, connect, start, save): the green accent
  button — `ac-btn-cyan` (legacy class name; now renders TeamYou green). One
  per surface.
- **Confirm / go** (`ac-btn-green`) is now visually redundant with the
  primary treatment — these two will be consolidated into one primary class
  during the markup sweep; don't introduce new uses of `ac-btn-green`.
- **Secondary / neutral**: `ac-btn-secondary` (bordered, quiet).
- **Ghost / low-emphasis**: `ac-btn-ghost`.
- **Destructive**: `ac-btn-danger` (red text treatment, confirm before acting).

### Feedback states

- Status dots: green (`healthy`, teamyou-green-400) and cobalt (`info`)
  with the existing subtle pulse.
- Loading: `ac-spinner` for inline waits; prefer skeleton placeholders for
  panel-sized content as components are migrated.
- Empty states: a sentence of explanation plus the relevant action — never a
  bare "no data".
- Toasts for transient confirmations only; inline status text for anything
  the user must act on.

### Focus and accessibility

- Every interactive element keeps a visible `focus-visible` outline (green
  accent at ~55% opacity, 2px offset — see `.ac-toggle-input:focus-visible`).
- Meet WCAG AA contrast in both themes. On green-400 fills, text is **black**.
- Color never carries meaning alone — pair status color with a label or icon.

---

## Motion

Functional and brief: 120–250ms ease transitions for hover/state, the
existing pop-in for action groups, subtle 2.6s status-dot pulses. Respect
`prefers-reduced-motion` (see `.ac-spinner`). No decorative or entrance
choreography; glow effects are being reduced, don't add new ones.

---

## Do not ship

- Cyan. The cyan accent is fully retired — anything cyan is unmigrated legacy.
- New hardcoded hex/rgba color in components or CSS — use theme variables or
  the `teamyou-*` scales.
- Green as decoration. Green marks identity, primary actions, and success —
  not arbitrary highlights (hovers are cobalt-tinted, not green).
- New status hues outside error/warning/success/info.
- New glow `box-shadow`s, gradients-as-decoration, or texture overlays.
- New all-caps/letter-spaced labels.
- A second primary button on one surface, or new `ac-btn-green` uses.
- Zinc/gray panel backgrounds or borders in dark mode — cobalt only.

---

## Migration status

Done (token layer):

- `theme.css` dark + light variables remapped to TeamYou values.
- Cyan accent family → teamyou-green across all CSS (`theme`, `shell`,
  `chat`, `cron`, `explorer`).
- Status families remapped (warning → amber, success → teamyou-green,
  info → teamyou-cobalt).
- Fonts: JetBrains Mono → Geist / Geist Mono.
- `tailwind.config.cjs`: Geist font stacks + `teamyou-green` /
  `teamyou-cobalt` scales available to components.

Pending (markup sweep):

- ~23 hardcoded `*-cyan-*` Tailwind classes in `lib/public/js/components/`
  (light-theme overrides in `theme.css` bridge some of these; dark theme
  still shows cyan until replaced).
- Consolidate `ac-btn-cyan` + `ac-btn-green` into one primary class with an
  honest name (e.g. `ac-btn-primary`).
- Reduce glow shadows; normalize 10px radii to 8px.
- Replace `.ac-small-heading` uppercase labels with sentence case.
- Decide fate of the `body::before` grid texture (default: remove).
- Consider 13px → 14px base font size after the sweep settles.
