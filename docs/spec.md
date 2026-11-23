# AGENTX Gateway — Design Spec

Status: agreed design (v0.1 scope). This document records the decisions made before
implementation. Update it when a decision changes; implemented behaviour is documented
under `docs/` per topic.

## 1. Purpose

A self-hostable, OpenAI-compatible API gateway and admin CRM for the AGENTX (formerly
LLMAvatar) Unity avatar application. Unity talks to it through its OpenAI-compatible
provider mode. The gateway:

1. Tracks every conversation session and stores transcripts (including thinking blocks
   and tool calls).
2. Holds the catalogue of media the avatar may show.
3. Holds the catalogue of camera streams the avatar may show.
4. Holds the registry of external MCP servers the avatar may query (Composio first).
5. Stores upstream LLM provider endpoints and keys, and fails over between providers.
6. Hosts **agents**: visual chatflows built in an editor and executed with LangGraph.js.

## 2. Repository and hosting

- Repo `jonmikeys/agentx-gateway`, public, MIT. Mounted in AGENTX as the submodule
  `Sidecars/Gateway`.
- Self-hosted with Docker Compose (app + Postgres). Must also run unchanged on a cloud VM:
  all config via env, no machine paths.
- Optional Caddy profile (`docker compose --profile tls up`) for automatic HTTPS. Startup
  logs a warning when admin auth is served over plain HTTP on a non-loopback address.
- Postgres data in a named volume; documented `pg_dump` backup.
- Container image published to `ghcr.io/jonmikeys/agentx-gateway` on tags.

## 3. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node 22.9+ LTS, TypeScript strict, pnpm |
| Web | Next.js (App Router) for the admin CRM; **Hono** mounted at `app/v1/[[...path]]/route.ts` (and `/agents`, `/health`) via `hono/vercel` `handle()` with `runtime = 'nodejs'` |
| DB | Postgres + Drizzle ORM + drizzle-kit migrations |
| Agents | LangGraph.js (`@langchain/langgraph`), Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) |
| MCP | `@modelcontextprotocol/sdk` client (Streamable HTTP, SSE fallback) |
| UI | shadcn/ui (Radix + Tailwind v4), lucide icons, TanStack Table, `@xyflow/react`, dagre auto-layout |
| Validation | Zod (shared between API, DB JSON columns and editor forms) |
| Lint/format | Biome |
| Tests | Vitest (+ Testcontainers Postgres), Hono `app.request()`, mock upstream provider, mock MCP server, Playwright smoke tests |
| CI | GitHub Actions: biome, typecheck, vitest, playwright, docker build; GHCR publish on tags |

The reference project `Azim-Ahmed/chat-flow-builder` is UX inspiration only (license
unknown, Vite/UnoCSS). No code is copied from it.

## 4. Auth

- **Admin CRM** (pages and `/api/admin/*`): HTTP Basic auth with `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` from env, implemented behind an `AdminAuth` seam so Better Auth can
  replace it later. Failed logins are rate-limited per IP.
- **Client API** (`/v1/*`, `/agents`): gateway-issued Bearer API keys. Stored as SHA-256
  hashes, shown once at creation, labelled (e.g. "Lobby kiosk"), optional IP allowlist
  (CIDR list), optional rate limits (requests/minute, tokens/day), revocable, `last_used_at`.
- `/health` is unauthenticated.

## 5. Secrets at rest

- Provider keys, MCP headers, webhook headers, camera credentials: AES-256-GCM encrypted
  in Postgres with `GATEWAY_ENCRYPTION_KEY` (32 bytes, base64). Startup fails if missing
  or malformed.
- Write-only in the CRM: masked display (`sk-…a1b2`); replace, never reveal.
- `pnpm secrets:rotate` re-encrypts every secret under a new key.
- Transcript text never appears in server logs (IDs, timings, error codes only).

## 6. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `GATEWAY_ENCRYPTION_KEY` | yes | base64 32-byte master key for secrets |
| `NEW_GATEWAY_ENCRYPTION_KEY` | no | replacement key, read only by `pnpm secrets:rotate` |
| `ADMIN_USERNAME` | yes | Basic auth user for the CRM |
| `ADMIN_PASSWORD` | yes | Basic auth password for the CRM |
| `PUBLIC_BASE_URL` | no | External URL (used for media content URLs and docs) |
| `MEDIA_STORAGE_DIR` | no | Upload storage directory (default `/data/media`) |
| `LOG_LEVEL` | no | `info` default |
| `GATEWAY_DOMAIN` | no | Domain for the Caddy TLS profile |

`.env.example` lists every variable with empty values. Startup validates required
variables and reports missing names without values.

## 7. Client-facing API

Base: `{PUBLIC_BASE_URL}/v1`. Unity's base URL includes `/v1` and builds
`{base}/chat/completions`, `{base}/models`, etc.

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | stream + non-stream; `tools`, `tool_choice`, `temperature`, `reasoning_effort`, `thinking`, extra `agent_id`. Unknown fields pass through upstream |
| `POST /v1/responses` | stream + non-stream; `store` ignored; tools. Native passthrough or translation (§9) |
| `GET /v1/models` | model routes + `agent:<id>` entries. Never requires `X-Session-Id` |
| `GET /v1/agents` (alias `GET /agents`) | `{"object":"list","data":[{"id","object":"agent","name","description","created"}]}` — published, enabled agents only |
| `GET /v1/media` | media catalogue (enabled items) |
| `GET /v1/media/{id}/content` | file serving with HTTP Range support |
| `GET /v1/cameras` | camera catalogue (enabled items) |
| `GET /health` | `{"ok":true,"db":true,"version":"…"}`; 503 when DB is down |

- Errors use the OpenAI shape `{"error":{"message","type","code"}}`.
- On chat routes **404 is reserved for `session_not_found`** (Unity treats any 404 on a
  session request as expiry).
- Unknown/disabled `agent_id` → `400 invalid_agent`.
- Rate limit exceeded → `429`.
- Token usage recorded per turn from upstream `usage` (`stream_options.include_usage`
  requested automatically). No cost tracking in v1.
- Out of scope: embeddings, images, audio, batch, files, Assistants, `n > 1`.
- CORS: expose `X-Session-Id`; allow `Authorization`, `X-Session-Id`, `Content-Type`.

## 8. Providers, model routes, failover

- **Provider**: name, base URL, encrypted API key, enabled, capability flags
  (`streaming`, `tools`, `responses_api`), optional extra headers. OpenAI-compatible
  upstreams only (OpenAI, Azure OpenAI, DeepSeek, Groq, OpenRouter, Together, Mistral,
  Ollama, vLLM, LM Studio, Anthropic/Gemini via their OpenAI-compatible endpoints).
- **Model route**: slug (e.g. `avatar-default`), description, ordered steps
  `(provider, upstream model, timeout_ms)`, allowed MCP tools (§12).
- Client `model` = route slug. `GET /v1/models` lists routes.
- Failover triggers: connection error, timeout, HTTP 408, 429, 5xx. Not other 4xx.
- Failover only **before the first streamed token** is sent to the client. After that an
  upstream error ends the stream with an error chunk.
- Circuit breaker: after N consecutive failures (default 3) skip the provider for 30 s.
- Each attempt (provider, model, latency, outcome, error code) is logged against the turn.

## 9. Responses API

- Internal canonical format is chat-completions (messages, tools, tool_calls).
- `/v1/responses` with no agent and a provider flagged `responses_api` → native passthrough.
- Otherwise translate Responses → Chat request and Chat stream → Responses SSE events
  (`response.created`, `response.output_item.added`, `response.output_text.delta`,
  `response.function_call_arguments.delta`, `response.completed`, …).

## 10. Sessions and transcripts

Implements the existing AGENTX session contract exactly
(`llmavatar/llm sessions/01 Protocol.md` in AGENTX):

- Request without `X-Session-Id` → new session; gateway generates a UUID.
- Every successful response carries `X-Session-Id` in headers before the first SSE event.
- Unknown/expired id → `404 {"error":{"code":"session_not_found","message":"…"}}`.
- Idle expiry (default 30 min, configurable in Settings). No client end signal.
- Admin can end a session from the CRM (next request → 404).
- A different `agent_id` than the session's agent → gateway ends the old session and
  returns a new `X-Session-Id` (Unity handles it as "conversation ended").
- Every request without a header gets a new session id per the contract; sessions that end
  with a single turn and no follow-up are flagged `standalone` (one-shot helper calls) and
  filtered out of the default Sessions view.
- Unity sends full history each turn; the gateway forwards it as-is and stores only the
  **new** items of each turn: new user message(s), assistant reply, reasoning text,
  tool calls + results (Unity and MCP), failover attempts, tokens, latency, agent run id.
- Session record: id, api key, model route, agent (+ version), status
  (`active|expired|ended`), started/last activity, turn count.
- Retention: default 90 days (0 = forever), nightly purge (sessions, turns, run logs,
  session memory, checkpoints). Manual hard delete (single or date range). Export JSON /
  Markdown per session, bulk CSV/JSON with filters. Optional regex redaction of emails and
  phone numbers before save (off by default).

## 11. Media Content

**Media**: id, name, description, kind (`image|video`), tags, enabled, source:
`upload` (stored in `MEDIA_STORAGE_DIR` behind a `MediaStorage` interface so S3 can be
added) or `external_url` (type/size checked on save). Limits: png/jpeg/gif/webp ≤ 20 MB;
mp4/webm ≤ 200 MB. `GET /v1/media` returns `{id, name, description, kind, tags,
content_url, mime_type}`. YouTube and S3 are out of scope.

**Cameras**: id, name, description, enabled, `type` (open union):
- `lookat_sidecar` — Unity's configured RealSense look-at provider `/video` feed.
- `mjpeg_url` — URL + optional encrypted credentials.
- Future: `rtsp_via_relay` (security cameras via go2rtc/MediaMTX). Keep the type open.

Unity connects to cameras directly (not proxied). Credentials are delivered to the
authenticated client.

## 12. MCP

- Registry: name, URL, transport (Streamable HTTP, fallback SSE), encrypted headers,
  enabled. No stdio in v1.
- CRM fetches `tools/list`; admin ticks allowed tools (deny by default). Exposed names are
  prefixed `<server_slug>__<tool>`.
- Composio first: API key + user id headers; account connections are made in Composio's
  dashboard.
- **Plain chats**: the route's allowed MCP tools are merged into the client's `tools`.
  The gateway executes MCP calls itself and loops (max 4 MCP rounds, 30 s per call).
  Unity tool calls are returned to Unity. Mixed responses: execute MCP calls, return only
  client calls, persist MCP call/result messages per session keyed by `tool_call_id`, and
  re-inject them when the client sends its tool results.
- Every MCP call is logged in the transcript (tool, args, result, duration, error).

## 13. Agents (chatflows)

### Model
- Agent = published chatflow. Flow kinds: `agent` and `subflow`.
- Draft (autosaved) + immutable numbered published versions; rollback restores into draft.
- Saved as React Flow JSON validated by per-node Zod schemas.
- At request time the published version is compiled into a LangGraph `StateGraph`
  (cached per version). State `{ messages, sessionId, vars, memory, output }`; the
  checkpointer stores vars/memory/interrupts under `thread_id = session id`.
- Output streams to the client as standard OpenAI chunks.
- Unknown agent → 400 `invalid_agent`. Client `model` ignored except by LLM nodes set
  to "inherit".

### Validation (on publish)
Exactly one Start (agents) or one Subflow Input (subflows); every path reaches Reply/End
or Subflow Output; no orphan nodes; required fields set; no cycles except marked loop
edges; no subflow call cycles; subflow nesting ≤ 5.

### Templates
`{{input.text}}`, `{{vars.x}}`, `{{memory.x}}`, `{{nodes.<id>.output}}` — safe
interpolation with dotted paths, no code execution.

### Nodes
| Node | Behaviour |
|---|---|
| Start | Entry; exposes latest user message, history, session id, request info |
| LLM | Model route or inherit; system prompt template; history full / last N / none; optional tools (MCP + client tools); output → var; streams if terminal |
| Router | Rules (equals/contains/regex on a template) or intent (LLM picks a label); one output handle per rule/label + default |
| Set Variable | Set/transform vars from templates |
| Webhook | Method, URL, encrypted headers, body template, timeout (10 s), retries 0–3, response size cap, JSON path mapping → vars; error handle |
| Memory | get / set / append / delete session memory keys |
| MCP Tool | Registry server + allowed tool; args fixed or templated; output → vars; error handle |
| Client Action | Emits a fixed Unity tool call (e.g. `show_video` with `media_id`) with catalogue pickers |
| Reply | Streams templated text mid-flow; multiple replies stream in order |
| End | Ends the turn |
| Subflow Input / Subflow Output | Declare subflow params / return values (multiple outputs → caller branches) |
| Call Subflow | Calls a subflow (pinned version), maps inputs, returns into vars |
| Note (sticky) | Canvas-only Markdown note; never executed |

Every fallible node has an optional `error` output handle. No code node, no
human-approval node in v1.

### Unity (client) tools inside agents
LLM nodes may offer the client tools from the request's `tools` array (narrowable per
node). When called, the run **interrupts** (LangGraph interrupt, checkpointed), the
gateway returns an OpenAI `tool_calls` response, and the next request carrying the tool
results **resumes** the run. Paused runs are discarded on session expiry.

### Per-agent restrictions
Allowed media tags and allowed cameras filter the enums offered to the model and the
Client Action pickers.

### Subflows
Reusable flows with declared inputs/outputs, compiled as nested subgraphs: own `vars`,
shared session `memory`, Replies stream to the client, interrupts work inside. Parents
pin the subflow version at publish ("update available" badge). Usage view; cannot delete
while referenced.

### Run logs
Every production run stores a per-node trace (inputs, outputs, timing, errors), linked
from the session transcript.

### Implementation notes (G7a)
Webhook header values are write-only in the editor and stored in `flow_webhook_secrets`
(AES-256-GCM, one row per flow/node/header, registered in the encrypted-column table) rather
than inside the graph JSON, so `pnpm secrets:rotate` covers them; the draft and versions keep
only header names. Client-tool pause/resume, the Client Action node and per-agent media/camera
restrictions ship in G7b slice A (see `docs/agents.md`); subflows, sticky notes, groups,
node-comment UI and version diff are the rest of G7b and have extension points (comment field,
flow kind, settings arrays, terminal/interrupt-aware runtime).

## 14. CRM

Sidebar groups (collapsible, state remembered; group of the current page auto-expands;
breadcrumbs; icon-only collapse; ⌘K/Ctrl+K command palette):

```
Overview               Dashboard
Conversations          Sessions (→ transcript viewer)
Agents                 Chatflows (agents + subflows → editor)
Media Content          Media, Cameras
Models & Integrations  Providers, Model Routes, MCP Servers
Administration         API Keys, Settings
```

- **Dashboard**: active sessions, sessions/turns per day, tokens per provider, failovers and
  errors, slowest providers.
- **Sessions**: table with filters, full-text transcript search, bulk export/delete.
- **Transcript viewer**: chat timeline; collapsible thinking blocks; tool-call cards
  (name, args, result, duration; Unity/MCP badge); per-turn metadata (provider, failovers,
  latency, tokens); agent run trace; session memory/vars; End / Delete / Export; live
  updates for active sessions.
- **Providers**: CRUD, test connection, health and circuit-breaker state.
- **Model Routes**: drag-to-reorder steps, allowed MCP tools.
- **Media / Cameras**: CRUD, thumbnails/preview.
- **MCP Servers**: register, test, browse tools, allowlist.
- **API Keys**: create (shown once), label, IP allowlist, rate limits, revoke, last used.
- **Settings**: idle timeout, retention days, redaction toggle, defaults.

### Chatflow editor
- Left palette (Flow / AI / Actions / Data / Notes), centre React Flow canvas (dotted grid,
  zoom, minimap, snap, dagre auto-layout), right properties panel (forms from Zod schemas,
  registry pickers), bottom drawer with test chat + trace (click a step to highlight its
  node; nodes light up while running).
- Node cards: icon, editable title, one-line summary; dynamic Router handles; error
  handles; validation badges + problems list.
- `{{…}}` autocomplete of available variables; invalid references underlined.
- Autosave draft, saved indicator, undo/redo, copy/paste, multi-select, delete.
- Publish dialog (validation, version note); version history (view, diff vs draft with
  changed nodes highlighted, restore); duplicate; JSON import/export (secrets by name,
  re-link on import).
- Agent settings tab: name, slug (`agt_…`, fixed once published), description, enabled,
  allowed media tags, allowed cameras, default model route.
- Concurrency: last save wins; warn if another save happened since opening.
- **Sticky notes**: Markdown, resizable, theme-token colours (yellow, blue, green, pink,
  grey), layering, `N` shortcut; versioned/exported; ignored by validator/compiler.
- **Node comments**: Comment field per node, speech-bubble badge + popover, last-edited
  time; travels with copy/version/export.
- Toolbar toggle hides notes and comments.
- **Visual groups**: Ctrl+G, titled frame, collapsible, "Convert group to subflow".

## 15. Unity integration (AGENTX repo)

- New **AGENTX Gateway** provider (subclass of the Custom OpenAI-compatible provider):
  env `GATEWAY_ENDPOINT`, `GATEWAY_API_KEY`.
- Agent dropdown (from `/v1/agents`, "None (direct model)") → `agent_id`; change resets
  the session.
- With the gateway provider active: fetch `/v1/media` and `/v1/cameras` at conversation
  start; register `list_media`; `show_image` / `show_video` take `media_id` (enum);
  `show_camera` takes `camera_id` (enum, optional when one camera). Other providers keep
  URL tools.
- Mock gateway `Tools/Gateway/mock_gateway.py`, vault topic `llmavatar/api gateway/`,
  `AGENT_Gateway.md`, dependency note, AGENTS.md section.

## 16. Delivery stages

Gateway repo — one issue + PR per stage:
G1 Scaffold · G2 Routing core · G3 Sessions · G4 Responses API · G5 Media Content ·
G6 MCP · G7a Agents editor + core runtime · G7b Client tools, Client Action, subflows,
groups, notes/comments, version diff · G8 Release (OpenAPI `/v1/openapi.json`, Scalar
`/docs` behind admin auth, docs pass, GHCR, `v0.1.0`).

AGENTX — one tracking issue, one PR on `feature/api-gateway`:
A1 Link (submodule, docs, mock) · A2 Gateway provider + agent picker · A3 Catalogue tools.

## 17. Assumptions

- Webhook targets are admin-authored and trusted (no SSRF blocklist; timeout + size cap).
- Single Node process; horizontal scaling is a later concern.
- Thinking blocks are recorded only when the provider streams them
  (`reasoning_content`, `reasoning`, `<think>` tags).
