# Repository Instructions

AGENTX Gateway: a self-hostable, OpenAI-compatible API gateway and admin CRM. Next.js (App Router) + Hono + Postgres/Drizzle. Standard TypeScript conventions apply (camelCase values, PascalCase types and components); the Unity C# naming rules of the AGENTX repo do NOT apply here.

## Read first

- Read [`docs/spec.md`](docs/spec.md) before planning or implementing anything. It is the agreed design; update it when a decision changes.
- Implemented behaviour is documented per topic under `docs/` ([`docs/development.md`](docs/development.md), [`docs/deployment.md`](docs/deployment.md)). Keep those pages current when behaviour changes.
- This is not the Next.js you may remember (Next 16: `proxy.ts` replaces `middleware.ts`, and so on). Check `node_modules/next/dist/docs/` before using a Next.js API from memory.

## Workflow

- Never commit to `main`. Work on a feature branch (for example `feature/g2-routing-core`) and open a pull request.
- Commit in coherent topics. Subject format: `[DEV] #N <imperative message>`; the body starts with `Issue: #N`. Use `Closes #N` only when a commit is meant to close the issue.
- Pull requests use `.github/pull_request_template.md` (`Summary`, `Changes`, `Testing`).
- Never commit `.env`, secrets, `node_modules`, `.next`, or other generated output.

## Quality gates (all must pass before a PR)

- `pnpm lint` (Biome) and `pnpm typecheck` (`tsc --noEmit`).
- `pnpm test:unit` and `pnpm test:integration` (needs Docker for Testcontainers). New behaviour needs tests in the same change: unit tests under `tests/unit/`, database or HTTP-level tests under `tests/integration/`, UI smoke flows under `e2e/`.
- `pnpm build`. Do not read the environment at import time: validate lazily (`getEnv()`) so `next build` works without secrets.
- CI (`.github/workflows/ci.yml`) runs all of the above plus Playwright and a Docker build.

## Configuration and secrets

- Every environment variable is validated in `src/server/env.ts` (Zod) and listed with a comment in `.env.example`. Keep both in sync, with empty values in the example. Never print secret values in logs or errors; report variable names only.
- Secrets stored in the database MUST go through `src/server/crypto/secrets.ts` (`encryptSecret` / `decryptSecret` / `maskSecret`) and the column MUST be registered in `src/server/crypto/encrypted-columns.ts` in the same change, so `pnpm secrets:rotate` covers it. Secrets are write-only in the CRM (masked display).
- Never log transcript text; log IDs, timings and error codes only.

## Architecture rules

- One Hono app defines the client API with full paths (`src/server/api/app.ts`) and is mounted in thin Next route files via `hono/vercel` `handle()` with `runtime = 'nodejs'`. Admin endpoints live in `src/server/api/admin-app.ts` under `/api/admin/*`.
- Client API errors use the OpenAI shape via `openAIError()`. On chat routes 404 is reserved for `session_not_found`; use `not_found` for unknown routes.
- Admin authentication goes through the `AdminAuth` seam (`src/server/auth/admin-auth.ts`); do not read credentials elsewhere. `src/proxy.ts` guards all CRM pages.
- Database changes: edit `src/server/db/schema.ts`, run `pnpm db:generate`, commit the generated SQL in `drizzle/`. Migrations apply automatically at server start and via `pnpm db:migrate`.
- UI: shadcn/ui components live in `src/components/ui` (generated, excluded from Biome). Add new ones with `pnpm dlx shadcn@latest add <name>`. Use theme tokens (no one-off colours). Navigation is defined once in `src/components/app-shell/nav.ts` (sidebar, breadcrumbs and command palette all read it).
