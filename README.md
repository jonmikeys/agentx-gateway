# AGENTX Gateway

Self-hostable, OpenAI-compatible API gateway and admin CRM for the AGENTX avatar
application: session and transcript tracking, media and camera catalogues, MCP server
registry, multi-provider failover, and visual agent chatflows built on LangGraph.js.

Status: v0.1.0 (first release). Everything in the [spec](docs/spec.md) for this version is
implemented: the client API, routing and failover, sessions, the Responses API, media and
cameras, MCP, agents with subflows and client tools, the admin CRM, and the Docker deployment.
See the [CHANGELOG](CHANGELOG.md).

## Features

- **OpenAI-compatible chat completions** (stream and non-stream) with ordered provider failover,
  a per-provider circuit breaker and automatic usage reporting.
  See [docs/providers-and-routes.md](docs/providers-and-routes.md).
- **Responses API** (`POST /v1/responses`): forwarded natively to providers that support it and
  translated to and from chat completions for the rest, per route step, with the same failover,
  sessions and transcripts. See [docs/responses-api.md](docs/responses-api.md).
- **Providers and model routes** managed in the CRM; provider keys are encrypted at rest and
  write-only.
- **Client API keys** with hashed storage, shown once, optional IP allowlist, requests/minute and
  tokens/day limits. See [docs/api-keys.md](docs/api-keys.md).
- **Sessions and transcripts**: the AGENTX `X-Session-Id` contract, stored transcripts with
  thinking blocks and tool calls, a transcript viewer with live updates, full-text search,
  retention, optional redaction and JSON/Markdown/CSV export.
  See [docs/sessions-and-transcripts.md](docs/sessions-and-transcripts.md).
- **Media and cameras**: image/video uploads (streamed to `MEDIA_STORAGE_DIR`, type sniffed
  from the bytes) or external URLs, served to Unity with HTTP `Range` support at
  `/v1/media`, plus an MJPEG camera catalogue with encrypted credentials at `/v1/cameras`.
  See [docs/media-content.md](docs/media-content.md).
- **MCP servers and tools**: register Streamable HTTP/SSE MCP servers, browse and allowlist
  tools, and let plain chats call them. The gateway executes MCP calls, loops (max four rounds),
  keeps Unity tools client-side, and re-injects mixed-round MCP messages on the next request.
  See [docs/mcp.md](docs/mcp.md).
- **Web search** (opt-in): a self-hosted SearXNG (compose profile `search`) powers built-in
  tools a route can offer: `web_search`, `read_web_page`, and `image_search` / `video_search`
  (YouTube) whose results the avatar can show. The gateway streams found media through, and
  resolves videos with a bundled yt-dlp. See [docs/web-search.md](docs/web-search.md).
- **Agents (chatflows)**: design agents in a React Flow editor, validate and publish numbered
  versions, and run them through LangGraph with session memory, streaming replies,
  checkpointing and a per-node run trace. `GET /v1/agents` lists live agents; requests use
  `agent_id` or the `agent:<id>` model. See [docs/agents.md](docs/agents.md).
  - Nodes: Start, LLM, Router, Set Variable, Webhook, Memory, MCP Tool, Client Action, Reply, End.
  - **Client-tool pause and resume**: when the model calls a Unity tool the run pauses, the
    client receives the call, and the next request with the tool results resumes it (chat and
    Responses, streamed or not).
  - **Client Action node**: sends a fixed Unity tool call (media, camera, animation) without a model.
  - **Per-agent restrictions**: allowed media tags and allowed cameras narrow what an agent can show.
  - **Subflows**: reusable flows with typed inputs and labelled outputs, pinned to a published version.
  - **Editor extras**: sticky notes, node comments, visual groups, convert-group-to-subflow,
    and a version diff against the draft.
- **API reference**: `GET /v1/openapi.json` serves an OpenAPI 3.1 document of the client API
  (no authentication), and `/docs` shows it as an interactive Scalar reference (admin sign-in).
- **Dashboard** with sessions, turns, tokens, failovers and provider latency.
- **Request log** (timings, attempts, token usage; never message content).
- Admin console with Basic auth, dark/light themes and a Ctrl+K command palette
  (screenshots in [docs/screenshots](docs/screenshots/README.md)).

## Quick start (Docker Compose)

Requires Docker with Compose v2.

```bash
cp .env.example .env
# edit .env: set GATEWAY_ENCRYPTION_KEY, ADMIN_USERNAME and ADMIN_PASSWORD
# a key can be generated with:  openssl rand -base64 32
docker compose up -d --build
```

`docker-compose.yml` builds the image from the local checkout (`build: .`, tagged
`agentx-gateway:local`). To run a published release instead, see
[Using the published image](docs/deployment.md#using-the-published-image).

Check `curl http://localhost:3000/health`; it returns `{"ok":true,"db":true,"version":"..."}`.
Database migrations run automatically at start. The app port binds to `127.0.0.1` by default.
For a LAN box, a cloud VM or automatic HTTPS, see [docs/deployment.md](docs/deployment.md).

### First sign-in

Open <http://localhost:3000>. The browser asks for HTTP Basic credentials: use `ADMIN_USERNAME`
and `ADMIN_PASSWORD` from `.env`. (Over plain HTTP these travel unencrypted; keep it to loopback
or a trusted LAN, or put TLS in front.)

### Set up a first route

In the CRM:

1. **Providers**: add a provider with a name, an OpenAI-compatible base URL (for example
   `https://api.openai.com/v1`) and its API key. The key is encrypted and shown masked afterwards.
   Use the test action to check it.
2. **Model Routes**: create a route (the slug is the model name clients send, for example
   `avatar-default`) with one or more steps, each a provider plus the upstream model name.
   The first route you create becomes the default.
3. **API Keys**: create a key for your client. It is shown **once**; copy it now.

### First request

```bash
curl -i http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer agx_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"avatar-default","messages":[{"role":"user","content":"Hello"}]}'
```

The response carries an `X-Session-Id` header. A request without that header starts a new session.
Send the same value back (`-H "X-Session-Id: <id>"`) on the next request and the gateway continues
the conversation and appends to its transcript. If the session was ended or expired, the gateway
answers `404 session_not_found`; retry once without the header to start a new session. Clients
send the full message history every time. Browse the result under **Sessions** in the CRM.

Add `"stream": true` for server-sent events. To call a published agent, send `"agent_id": "agt_..."`
or use `"model": "agent:<id>"`.

## API reference

- Interactive reference: `/docs` on your gateway (behind the admin sign-in).
- Machine-readable spec: `GET /v1/openapi.json` (OpenAPI 3.1, no authentication).
- Behaviour guides: [providers and routes](docs/providers-and-routes.md),
  [sessions](docs/sessions-and-transcripts.md), [Responses API](docs/responses-api.md),
  [media and cameras](docs/media-content.md), [MCP](docs/mcp.md), [agents](docs/agents.md),
  [API keys](docs/api-keys.md).

## Documentation

- [Deployment](docs/deployment.md): LAN box, cloud VM with HTTPS, published image, backups, upgrades.
- [Operations](docs/operations.md): key rotation, retention, logs, health checks, rate limiting.
- [Development](docs/development.md): layout, testing, conventions.
- [Design spec](docs/spec.md) and [CHANGELOG](CHANGELOG.md).

## Local development

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp .env.example .env                              # fill in; `pnpm secrets:genkey` prints a key
docker compose -f docker-compose.dev.yml up -d    # Postgres on localhost:5432
# in .env: DATABASE_URL=postgres://agentx:agentx@localhost:5432/agentx
pnpm dev
```

See [docs/development.md](docs/development.md) for the project layout, testing and conventions.

## Configuration

All configuration is through environment variables, validated at start (a missing or invalid
variable is reported by name, never by value). [`.env.example`](.env.example) documents every one.
Docker Compose loads `.env` automatically.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes (see note) | none | Postgres connection string (`postgres://` or `postgresql://`) |
| `GATEWAY_ENCRYPTION_KEY` | yes | none | Base64 32-byte master key encrypting stored secrets. Generate with `pnpm secrets:genkey` or `openssl rand -base64 32`. Losing it makes stored secrets unrecoverable |
| `NEW_GATEWAY_ENCRYPTION_KEY` | no | none | Replacement key, read only by `pnpm secrets:rotate`. See [operations](docs/operations.md#rotating-the-encryption-key) |
| `ADMIN_USERNAME` | yes | none | HTTP Basic auth user for the admin console |
| `ADMIN_PASSWORD` | yes | none | HTTP Basic auth password for the admin console |
| `PUBLIC_BASE_URL` | no | none | External URL of the gateway, used for the absolute `content_url` of media. A warning is logged if it is plain `http://` on a non-loopback host |
| `MEDIA_STORAGE_DIR` | no | `/data/media` | Directory for uploaded media. A volume in Compose; use `./data/media` for local `pnpm dev` |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |
| `GATEWAY_DOMAIN` | no | `localhost` in Compose | Public domain for the Caddy `tls` profile. Needed only with that profile |
| `SEARXNG_URL` | no | none | SearXNG base URL. Turns on the built-in web search tools (`http://searxng:8080` with the `search` profile). See [web search](docs/web-search.md) |
| `SEARCH_SAFESEARCH` | no | `1` | SearXNG safe search sent with every query: `0` off, `1` moderate, `2` strict |
| `YTDLP_PATH` | no | `yt-dlp` | yt-dlp executable for video playback; bundled in the image, set it only for local `pnpm dev` |
| `SEARXNG_SECRET` | Compose only | empty | Secret the `search` profile's SearXNG signs cookies with |
| `POSTGRES_USER` | Compose only | `agentx` | Credentials for the bundled `postgres` service |
| `POSTGRES_PASSWORD` | Compose only | `agentx` | Set a random value for anything beyond local use |
| `POSTGRES_DB` | Compose only | `agentx` | Database name of the bundled `postgres` service |
| `GATEWAY_PORT` | Compose only | `3000` | Host port for the app |
| `GATEWAY_BIND_ADDRESS` | Compose only | `127.0.0.1` | Host address the app port binds to. Use `0.0.0.0` only on a trusted LAN |

Note: with Docker Compose, `DATABASE_URL` is ignored. The app container builds it from
`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` and the bundled `postgres` service. For
`pnpm dev` or any non-Compose run you must set it. The Compose-only variables are read by
`docker-compose.yml` and the container entrypoint, not by the application's environment schema.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development, production build, production server |
| `pnpm lint` / `pnpm format` | Biome check / format |
| `pnpm typecheck` | TypeScript (`tsc --noEmit`) |
| `pnpm test:unit` | Vitest unit tests |
| `pnpm test:integration` | Vitest + Testcontainers Postgres (needs Docker) |
| `pnpm test:e2e` | Playwright tests against a running app |
| `pnpm screenshots` | Regenerate `docs/screenshots` (needs a running app and a fresh database) |
| `pnpm db:generate` / `db:migrate` / `db:studio` | Drizzle migrations and studio |
| `pnpm secrets:genkey` | Print a fresh base64 `GATEWAY_ENCRYPTION_KEY` |
| `pnpm secrets:rotate` | Re-encrypt stored secrets under `NEW_GATEWAY_ENCRYPTION_KEY` |

## License

MIT. See [LICENSE](LICENSE).
