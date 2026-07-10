# TeamYou / OpenClaw Memory Integration — Analysis & Options

**Date:** 2026-07-09
**Status:** Analysis / decision doc — no changes implemented yet
**Repos involved:** `alphaclaw`, `clawctl`, `teamyou-openclaw-memory`, `teamyou`, `openclaw` (npm dep, v2026.6.10)

## Why this doc exists

Two questions came up while iterating on the Optional Tools setup screen:

1. Do we need the user-facing API key field "used for memory embeddings", given that we auto-install the TeamYou active memory plugin?
2. Can our instances (Hetzner CPX31: 4 vCPU / 8 GB) generate embeddings locally via OpenClaw's supported option?

Investigating those surfaced a bigger architectural question: agent-written memories (and transcripts) never reach TeamYou — the TeamYou store is intentionally user-curated — so what are our options for restoring recall over locally written memory, up to and including making TeamYou a bona fide OpenClaw memory backend?

---

## Part 1 — Current state: memory search is entirely off on our fleet

### The slot mechanism

OpenClaw's `plugins.slots.memory` is a strict **single-owner** slot (`dist/slots-kpL659LX.js`, `dist/memory-runtime-BnrWbfn1.js`). The core plugin `memory-core` ships `activation.onStartup: false` and only loads when it owns the slot. Its `register()` is what provides `memory_search`/`memory_get`, file indexing, the "Memory Recall" prompt section, and the pre-compaction memory flush.

On every AlphaClaw-managed instance the slot is never `memory-core`:

- Onboarding pre-seeds `plugins.slots.memory = "none"` (`lib/server/onboarding/openclaw.js:263`), and the bootstrap gate keeps forcing it.
- TeamYou activation flips it to `"openclaw-teamyou-memory"` (`lib/server/teamyou-memory-activation.js:464`).
- Neither clawctl's installer (`assets/host/lib/teamyou-install.sh`) nor alphaclaw ever writes an enabled `plugins.entries["memory-core"]` — it's only allow-listed.

**Consequences:** `memory_search`/`memory_get` are never registered, nothing indexes `MEMORY.md`/`memory/*.md`, there is no memory-flush nudge, and the memory files are effectively inert (readable only via ordinary file tools). Pre-turn recall is OpenClaw's separate `active-memory` sub-agent plugin, which clawctl configures with `toolsAllow: ["teamyou_retrieve_context"]` — TeamYou only.

### The embeddings key field is a dead path, twice over

- The Optional Tools OpenAI/Gemini fields (`lib/public/js/components/onboarding/welcome-form-step.js:806-857`, help text "Used for memory embeddings") land in `.env` and provider auth profiles.
- AlphaClaw's managed memory-search defaults (`applyManagedMemorySearchDefaults`, `lib/server/onboarding/openclaw.js:294`) wire `agents.defaults.memorySearch` to **`AI_GATEWAY_API_KEY`** (Vercel AI Gateway, `text-embedding-3-small`) — not the user-submitted key. And that entire config block is dead while `memory-core` is unslotted.
- The fields do double duty as model-provider credentials (Gemini also feeds Nano Banana image gen). The embeddings rationale is gone; keep/relabel the fields only for those other purposes.

### Local embeddings feasibility (CPX31)

OpenClaw's supported local option is `memorySearch.provider: "local"` via `@openclaw/llama-cpp-provider` (node-llama-cpp), auto-downloading `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB). Spec-wise it fits (~1–1.5 GB resident at default `contextSize: 4096`), but it requires baking a native-module plugin into provisioning and competes with the gateway for shared CPU/RAM. **Not recommended.** If a no-key fallback is ever needed: leaving `memorySearch.provider` unset (or `"none"`) degrades gracefully to SQLite FTS5/BM25 keyword search; only an *explicitly set* remote provider with broken auth fails closed.

### Decisions this supports

- **Drop the "memory embeddings" justification** from the Optional Tools step; no user-facing embeddings key is needed in any current or proposed configuration.
- Cleanup candidate: `applyManagedMemorySearchDefaults` writes config that cannot execute today and misleads readers of `openclaw.json`.

---

## Part 2 — Restoring search over memory files: two architectures

The gap: TeamYou is user-curated, so agent-written memories/transcripts aren't in it. Losing OpenClaw file search is a real loss. Two viable designs, both proven feasible:

### Key fact: the TeamYou plugin isn't really a slot implementation today

`openclaw-teamyou-memory` declares `kind: "memory"` but implements none of the slot contract — no `registerMemoryRuntime`, no `memory_search`/`memory_get`, no prompt section, no flush resolver. Its entire runtime surface is one `registerTool("teamyou_retrieve_context", { optional: true })` call plus a `gateway_start` log hook and CLI commands. Slot ownership buys it nothing except displacing `memory-core`; the tool is only visible where allowlisted (active-memory's `toolsAllow`), so main-agent behavior is unaffected by who owns the slot. The install-time slot juggling in `teamyou-install.sh` exists *only because* of the `kind: "memory"` declaration.

### Option A — Honcho pattern (TeamYou plugin keeps the slot)

Reference: `plastic-labs/openclaw-honcho`. A slot-owning plugin can serve standard file search itself because OpenClaw exports the machinery to plugins:

- `openclaw/plugin-sdk/memory-core-engine-runtime` exports `getMemorySearchManager` / `MemoryIndexManager` — the same builtin-SQLite/QMD manager `memory-core` uses.
- The plugin registers passthrough `memory_search`/`memory_get` tools (declared in manifest `contracts.tools`), calls `api.registerMemoryRuntime({ getMemorySearchManager, resolveMemoryBackendConfig })` (feature-detected), and `api.registerMemoryPromptSection`.

Cost: real plugin code maintained against an evolving host contract (Honcho's changelog documents host-version breakage).

### Option B — Composition flip (recommended for the file-search goal alone)

1. Drop `kind: "memory"` from the TeamYou plugin manifest (`openclaw.plugin.json` + `index.ts`) — it needs no slot APIs. It keeps loading via `plugins.entries[...].enabled = true`, which clawctl already writes.
2. Activation writers (clawctl installer + alphaclaw watcher) set `plugins.slots.memory = "memory-core"` (or stop forcing `"none"` — memory-core is the default owner when unset).
3. Extend active-memory `toolsAllow` to `["teamyou_retrieve_context", "memory_search", "memory_get"]` so pre-turn recall consults both stores.

Everything stock returns for free: file search, recall prompt nudge, and the pre-compaction flush (which is what keeps the agent *writing* memory files). Open design question: whether memory-core is active from first boot or stays gated pre-bootstrap (the original gate reasoning was TeamYou-specific and doesn't obviously apply).

### QMD backend (composable with either option)

`memory.backend: "qmd"` (tobi/qmd sidecar) adds transcript indexing (`memory.qmd.sessions.enabled: true` — recall over past conversations that never touched TeamYou or memory files), extra indexed paths, and reranking.

**CPX31 guidance:** default `searchMode: "search"` is BM25-only — no embeddings, no API keys, no model downloads; safe. Semantic modes (`vsearch`/`query`) auto-download ~2 GB GGUF models and run CPU reranking per query (docs advise raising the 4 s timeout to 120 s on slow hardware) — avoid on this fleet. Operational cost: bake the `qmd` binary into cloud-init and pin its path for the systemd gateway.

---

## Part 3 — Making TeamYou a bona fide memory backend (writes included)

### What the slot contract requires (OpenClaw 2026.6.10)

`api.registerMemoryCapability({ runtime, flushPlanResolver, promptBuilder, publicArtifacts })`, where the runtime's `MemorySearchManager` must implement `search`, `readFile`, `status`, `probeEmbeddingAvailability`, `probeVectorAvailability`. **The interface is read-only — OpenClaw has no write method in the memory contract.** Default memory writes are agent file-edits steered by the flush turn's prompt. A slot plugin redirects writes via:

1. **Its own write tools** (`memory-lancedb` ships `memory_store`/`memory_forget`) — e.g. `teamyou_store_memory`.
2. **A `flushPlanResolver`** whose prompt targets those tools instead of file edits. Quirk: `relativePath` is mandatory and the host pre-creates an empty file there — point it at a scratch path.
3. **Hook capture** (`agent_end`/`before_compaction`/`before_reset` deliver the turn's messages). This is Honcho's model — ship raw turns, distill server-side. TeamYou has no derivation pipeline, so the agent-distilled model (tools + flush prompt) fits better; distillation happens on-instance.

Read mapping: `search` → `POST /search/topics` + `/search/details`; `readFile` → synthetic paths (`topics/<id>.md` rendered from `GET /topics/{id}`, line-sliced — same trick as Honcho's `sessions/<id>.txt`).

**Hard limit:** dreaming/short-term promotion are memory-core-internal and not slot-overridable. A TeamYou backend loses them unless consolidation is rebuilt server-side (TeamYou's Vercel Workflow/heartbeat infra makes "promote agent memories into suggested topics" a plausible product feature).

### TeamYou-side findings (corrects a wrong premise)

The external API is **not read-only**. Live today under `app/api/external/v1/`:

- `POST/PUT/DELETE` topics, `POST` (batch ≤50)/`PUT/DELETE` details, `POST/PATCH/DELETE` edges — Zod-validated, embeddings generated synchronously on write (`text-embedding-3-small`, 1536-dim pgvector, HNSW, hybrid RRF search with recency boost + one-hop edge injection).
- Write rate limits (60/min), plan caps, and credit metering already enforced. Key auth: SHA-256-hashed `ty_` keys bound to a single Clerk user.

The gaps are governance, not plumbing:

| Gap | Detail | Existing pattern to copy |
|---|---|---|
| No provenance on topics/details | No `createdByAgentId`/`source` — can't distinguish agent-written from user-curated | `agent_documents.createdByAgentId → connected_agents` |
| No draft/review queue | Agent writes land directly in the live curated graph | `agent_instructions` `pending → delivered → acknowledged` |
| No per-key scopes | Any valid key is full CRUD; `aiUpdateEnabled`/`aiDeleteEnabled` prefs gate update/delete but **not create** | — (new `scopes` column on `api_keys`) |
| No soft-delete | Hard delete + cascade on knowledge tables | `todos.isArchived`, `agent_instructions.archivedAt` |

### Recommended shape: AgentCloudDrive as the agent-memory store

OpenClaw's memory model is *file-shaped* (append `memory/YYYY-MM-DD.md`, curate `MEMORY.md`); `agent_documents` (ACD) is a *path-addressed document store with agent provenance, upsert-by-path, and contentHash*. The flush turn can literally upsert `memory/2026-07-09.md` into ACD. The curated topics/details graph stays untouched; agent memory lives in a parallel, provenance-tagged store the user can browse, prune, or promote.

TeamYou changes, ordered by necessity:

1. **`agent_document_embeddings`** — already anticipated in the `agent_documents` header comment; same pattern as `detail_embeddings`. Probably background-embedded (like todos) since flush writes are bursty.
2. **Search inclusion** — a `sources` filter on existing search endpoints or a `/search/drive` endpoint, so the plugin's search manager fans across curated + agent-memory sources with distinct `source` tags.
3. **API key scopes** — `read` / `write:agent-memory` / `write:knowledge`; instance-provisioned keys default to agent-memory writes only. **Treat as a prerequisite** — routine agent writes with today's full-CRUD keys are a blast-radius risk.
4. Later: provenance columns on topics/details (for agent proposals to the curated graph), a promotion flow (agent memory → suggested topic — the dreaming replacement), soft-delete/versioning for agent documents (`memory_forget` = tombstone).

### Effort & trade-offs

- **Plugin:** ~1–2 weeks — capability registration, search/readFile mapping, write tool(s), flush plan, host-version feature detection.
- **TeamYou:** days if scope-cut to "direct writes + provenance columns"; a few weeks for the full ACD-embeddings + search + scopes + review UI version (mostly product/UX).
- **Trade-offs vs Option B:** memory becomes network-bound and online-only (file memory works offline and costs nothing); transcript recall (QMD sessions) isn't covered unless transcripts ship to TeamYou, which re-raises the curation question. A hybrid is legitimate: TeamYou as durable write target with the plugin's search manager also consulting a local index (composite manager).

---

## Decision summary

| Question | Answer |
|---|---|
| Keep the embeddings key field in Optional Tools? | No — dead path in every configuration; relabel/keep fields only for model-credential / Nano Banana purposes |
| Local embeddings on CPX31? | Feasible but not worth it; FTS/BM25 fallback or fleet `AI_GATEWAY_API_KEY` covers all real needs |
| Restore memory-file search cheaply? | Option B (composition flip): drop `kind: "memory"` from the TeamYou plugin, slot `memory-core`, extend `toolsAllow` |
| Transcript recall? | QMD backend, BM25-only mode, `sessions.enabled: true` |
| TeamYou as full memory backend? | Achievable; write API already exists; build agent memory on ACD + embeddings + key scopes; decide the curation/promotion product story first |

## Key file anchors

- alphaclaw: `lib/server/onboarding/openclaw.js` (slot seeding, `applyManagedMemorySearchDefaults`), `lib/server/teamyou-memory-activation.js`, `lib/public/js/components/onboarding/welcome-form-step.js:806-857`
- clawctl: `assets/host/lib/teamyou-install.sh` (config writer), `src/provisioning/defaults.ts` (CPX31)
- teamyou-openclaw-memory: `openclaw.plugin.json` (`kind: "memory"`), `index.ts`, `tool.ts`
- teamyou: `lib/db/schema/{topics,embeddings,edges,api-keys,connected-agents,agent-documents}.ts`, `lib/services/external-api-service.ts`, `lib/agent-auth.ts`, `app/api/external/v1/**`
- openclaw docs: `docs/concepts/memory-qmd.md`, `docs/concepts/memory-honcho.md`, `docs/plugins/sdk-subpaths.md`, `docs/reference/memory-config.md`
- Reference implementation: `github.com/plastic-labs/openclaw-honcho` (`tools/memory-passthrough.ts`, `runtime.ts`, `hooks/capture.ts`)
