# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-24

### Added

- `POST /v1/sessions/{id}/end`: a client can end its own session, for example when the user
  returns to a menu. It uses the client API key, only ends sessions owned by that key
  (`end_reason = client`) and always answers `204 No Content` (unknown, expired, already ended
  and other-key ids are silent no-ops), so it is idempotent and cannot probe ids. The next chat
  request with that id gets `404 session_not_found`. Documented in `GET /v1/openapi.json` and
  [`docs/sessions-and-transcripts.md`](docs/sessions-and-transcripts.md). Clients are not
  required to call it: idle sessions still expire on their own.

## [0.1.0] - 2026-11-23

First release.

### Added

#### Client API

- OpenAI-compatible `POST /v1/chat/completions` (stream and non-stream) and `GET /v1/models`,
  with OpenAI-shaped errors. Unknown request fields pass through to the upstream provider.
- `POST /v1/responses`: the Responses API, forwarded natively to providers that support it and
  translated to and from chat completions for the rest, per route step.
- `GET /v1/agents` (alias `GET /agents`) listing published, enabled agents; `GET /v1/media`,
  `GET /v1/media/{id}/content` and `GET /v1/cameras` catalogues; unauthenticated `GET /health`.
- Client API keys (`agx_...`): hashed storage, shown once, revocable, optional IP and CIDR
  allowlist, requests-per-minute and tokens-per-day limits. CORS exposes `X-Session-Id`.

#### Routing and failover

- Providers (OpenAI-compatible upstreams) and model routes with ordered steps, a default route
  and per-step timeouts. Provider API keys and extra headers are encrypted at rest and
  write-only.
- Automatic failover on upstream errors, a per-provider circuit breaker, first-chunk-aware
  streaming failover, and automatic usage reporting.
- Request log with timings, attempts and token usage; it never stores message content.

#### Sessions and transcripts

- The AGENTX `X-Session-Id` contract: sessions are created by the gateway, continued by the
  header, and answered with `404 session_not_found` when ended or expired.
- Transcript capture of new messages only, thinking blocks (`reasoning_content`, `reasoning`,
  `<think>` tags), tool calls and tool results; optional email and phone redaction.
- Sessions list and transcript viewer with live updates, full-text search, standalone-session
  filter, end and delete actions, and JSON, Markdown and CSV export.
- Idle-timeout sweeper and an hourly retention purge, configurable on the Settings page.

#### Media and cameras

- Image and video upload (streamed to `MEDIA_STORAGE_DIR`, type sniffed from the bytes) or
  external URLs, served with HTTP `Range` support, with tags and descriptions for the model.
- MJPEG camera catalogue with encrypted credentials, connection test and an admin-only preview
  proxy.

#### MCP

- MCP server registry (Streamable HTTP and SSE) with tool discovery, per-tool allowlisting and
  encrypted headers.
- Plain-chat tool loop (up to four rounds): the gateway executes MCP calls, keeps Unity tools
  client-side and re-injects mixed-round MCP messages on the next request.

#### Agents

- Visual chatflow editor (React Flow) with Start, LLM, Router, Set Variable, Webhook, Memory,
  MCP Tool, Client Action, Reply and End nodes; validation, numbered published versions,
  version history with restore, JSON import and export, a test drawer with a live trace, and
  keyboard shortcuts.
- LangGraph.js runtime with Postgres checkpointing, session memory, streaming replies over
  Chat Completions and Responses, and a per-node run trace stored per turn. Agents are selected
  with `agent_id` or the `agent:<id>` model; changing agents mid-session starts a new session.
- Client-tool pause and resume: Unity tool calls pause the run and the next request with the
  results resumes it, including mixed MCP and client calls and calls inside subflows.
- Client Action node for fixed Unity tool calls without a model.
- Per-agent restrictions (allowed media tags and allowed cameras) that narrow offered tools,
  pickers and publish-time validation, and are enforced at run time inside subflows.
- Subflows: reusable flows with typed inputs and labelled outputs, version pinning, cycle and
  depth checks, usage tracking and delete protection.
- Editor extras: sticky notes, node comments with badges, visual groups, convert-group-to-subflow
  and a version diff against the draft.
- Encrypted webhook header storage covered by key rotation.

#### Admin CRM

- Next.js admin console with HTTP Basic auth, sidebar navigation, breadcrumbs, a Ctrl+K command
  palette and dark and light themes. Pages: Dashboard, Sessions, Chatflows, Media, Cameras,
  Providers, Model Routes, MCP Servers, API Keys and Settings.
- Dashboard with sessions, turns, tokens, failovers and provider latency.
- Failed-login rate limiting per client address.
- UI QA checklist and layout end-to-end guards; CRM screenshots in `docs/screenshots`.

#### Operations and deployment

- Docker image (Next.js standalone, non-root, health check) and a Compose stack with Postgres
  and an optional Caddy `tls` profile for automatic HTTPS.
- Database migrations applied automatically at server start.
- AES-256-GCM secrets at rest with `pnpm secrets:genkey` and a transactional
  `pnpm secrets:rotate` over a central registry of encrypted columns.
- Environment validation with names-only error messages, a plain-HTTP warning, and JSON logs that
  never contain transcript text.
- Guides for deployment, operations, backups, upgrades and key rotation.

#### API reference

- `GET /v1/openapi.json`: an OpenAPI 3.1 document of the client API generated from the Zod
  schemas, served without authentication.
- `/docs`: an interactive Scalar API reference behind the admin sign-in.

#### CI and release

- GitHub Actions CI: lint (Biome), typecheck, unit and integration tests (Testcontainers),
  Playwright end-to-end tests, build and Docker image build.
- Release workflow: pushing a `v*` tag builds the Docker image and publishes it to
  `ghcr.io/jonmikeys/agentx-gateway` with the `<version>`, `<major>.<minor>` and `latest` tags.

[0.2.0]: https://github.com/jonmikeys/agentx-gateway/releases/tag/v0.2.0
[0.1.0]: https://github.com/jonmikeys/agentx-gateway/releases/tag/v0.1.0
