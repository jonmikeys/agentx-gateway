# Development guide

## Prerequisites

Node 22+ (see `.nvmrc`), pnpm 10, Docker (for Postgres and the integration tests).

## First run

```bash
pnpm install
cp .env.example .env
pnpm secrets:genkey                                # paste into GATEWAY_ENCRYPTION_KEY
docker compose -f docker-compose.dev.yml up -d     # Postgres on localhost:5432
```

Set in `.env`: `DATABASE_URL=postgres://agentx:agentx@localhost:5432/agentx`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD`. Then `pnpm dev` and open <http://localhost:3000>. Migrations run
automatically when the server starts (`src/instrumentation.ts`); `pnpm db:migrate` runs them
on demand. `.env` is read by Next.js and by the `db:*` / `secrets:*` scripts; Vitest does not
need it.

## Layout

| Path | Purpose |
|---|---|
| `src/app/(crm)/` | Admin console pages inside the sidebar shell (Dashboard, Sessions, Providers, Model Routes, API Keys, Settings implemented; the rest are placeholders) |
| `src/app/v1`, `src/app/agents`, `src/app/health` | Thin Next route files that mount the Hono client API |
| `src/app/api/admin` | Mounts the admin Hono app (requires AdminAuth) |
| `src/proxy.ts` | Guards every CRM page and `/api/admin/*` with HTTP Basic auth |
| `src/server/api/` | Hono apps (`app.ts` client API, `admin-app.ts` admin API, `admin/*` CRUD routers, `client-routes.ts`) and `openAIError()` |
| `src/server/services/` | Providers, routes, API keys, settings, sessions, exports, maintenance and dashboard services shared by the admin API and server components |
| `src/server/gateway/transcript/` | Pure transcript logic: new-item diffing, `<think>` splitting, response capture, redaction |
| `src/server/gateway/` | Chat proxy with failover, circuit breaker, SSE parser, client auth, CIDR matcher, rate counters |
| `src/lib/gateway-schemas.ts` | Zod schemas shared by the admin API and CRM forms |
| `src/server/auth/` | `AdminAuth` seam, `BasicAdminAuth`, failed-login rate limiter |
| `src/server/crypto/` | AES-256-GCM secrets, the encrypted-column registry, key rotation |
| `src/server/db/` | Drizzle schema, lazy client, migration runner |
| `src/server/env.ts` | Zod-validated environment (lazy, names-only errors) |
| `src/components/app-shell/` | Sidebar, header, breadcrumbs, command palette; `nav.ts` is the single nav definition |
| `src/components/ui/` | shadcn/ui components (generated; excluded from Biome) |
| `drizzle/` | Generated SQL migrations (commit them) |
| `tests/unit`, `tests/integration`, `e2e` | Vitest unit, Vitest + Testcontainers, Playwright smoke |

## How requests are routed

```
Browser / Unity -> Next.js
  /, /sessions, ...  -> src/proxy.ts (Basic auth + rate limit) -> CRM page
  /api/admin/*       -> src/proxy.ts -> Hono admin app (auth again, defence in depth)
  /v1/*, /agents     -> Hono client API (Bearer API key auth; CORS exposes X-Session-Id)
  /health            -> Hono client API (public)
```

`src/proxy.ts` (Next 16's replacement for `middleware.ts`) runs on the Node.js runtime. Its
matcher excludes `/v1`, `/agents`, `/health`, `/_next` and static assets. The failed-login
limiter keeps state in memory (10 failures per IP in 5 minutes blocks that IP for 5 minutes);
behind a reverse proxy the client IP comes from `X-Forwarded-For`, which Caddy sets.

## Adding things

- **Env variable**: add it to `envSchema` in `src/server/env.ts`, to `.env.example` (empty value
  plus a comment), and to the table in `docs/spec.md`.
- **Table**: edit `src/server/db/schema.ts`, run `pnpm db:generate`, commit `drizzle/`.
- **Encrypted column**: store the value with `encryptSecret()`, display with `maskSecret()`, and
  register the column in `src/server/crypto/encrypted-columns.ts`.
- **CRM page**: add it to `nav.ts` (groups/pages), then a `page.tsx` under `src/app/(crm)/`.
- **shadcn component**: `pnpm dlx shadcn@latest add <name>`.
- **Client API route**: define it with its full path in `src/server/api/app.ts`; errors use
  `openAIError()`. Remember 404 on chat routes means `session_not_found`.

## Secrets and key rotation

`GATEWAY_ENCRYPTION_KEY` is a base64 32-byte key (`pnpm secrets:genkey`). Stored secrets use the
format `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, random 12-byte IV). To rotate:

```bash
# Generate the replacement key and save it somewhere safe first: rotation never prints it.
export NEW_GATEWAY_ENCRYPTION_KEY="$(pnpm -s secrets:genkey)"
echo "$NEW_GATEWAY_ENCRYPTION_KEY"
pnpm secrets:rotate
# then set GATEWAY_ENCRYPTION_KEY to that saved value and restart
```

Rotation re-encrypts every column in the registry inside one transaction. Take a `pg_dump`
backup first, and keep the new key somewhere safe: without it secrets are unrecoverable.

## Testing

| Command | What it covers |
|---|---|
| `pnpm test:unit` | Secrets (round trip, tamper detection, masking), env validation, AdminAuth parsing and rate limit, `openAIError`, CORS and 404 shape, nav data integrity, CIDR matcher, API key format, route selection, failover classifier and error mapping, circuit breaker, SSE parser |
| `pnpm test:integration` | Migrations apply to a real Postgres (Testcontainers), `/health`, secret rotation (including the provider columns), the admin API (secrets never returned), and the client API against `tests/support/mock-upstream.ts`: passthrough, failover, circuit breaker, error mapping, auth, allowlist and rate limits, request log, sessions (header contract, transcript capture, retention, exports, search, dashboard stats). Needs Docker |
| `pnpm test:e2e` | Playwright against a running app (also the sessions viewer: search, thinking, tool card, end session and the layout guards of `e2e/layout.spec.ts`, see [`ui-qa.md`](ui-qa.md)): 401 without credentials, sidebar groups, navigation, Ctrl+K palette, `/api/admin/me`, and the G2 flow (create provider, test it, create route and API key, call the gateway through a mock upstream) |
| `pnpm screenshots` | Captures every CRM page plus key states (light and dark, 1440x900) into `docs/screenshots`. Needs a running app and a fresh database (it also reads `DATABASE_URL`, default `postgres://agentx:agentx@localhost:5432/agentx`, to backdate demo history); see `playwright.screenshots.config.ts` |

Run the e2e tests against a built app:

```bash
pnpm build
pnpm start &
until curl -fsS http://localhost:3000/health >/dev/null; do sleep 1; done
E2E_ADMIN_USERNAME=<ADMIN_USERNAME> E2E_ADMIN_PASSWORD=<ADMIN_PASSWORD> pnpm test:e2e
```

First time only: `pnpm exec playwright install chromium`. `E2E_BASE_URL` points the tests at a
different host (default `http://localhost:3000`).

## Quality gates

`pnpm lint`, `pnpm typecheck`, tests and `pnpm build` must pass; CI also runs Playwright and a
Docker build. `pnpm start` prints a Next.js notice about `output: standalone`; it still works
locally, and the Docker image runs `node server.js` from the standalone output.
