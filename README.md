# AGENTX Gateway

Self-hostable, OpenAI-compatible API gateway and admin CRM for the AGENTX avatar
application: session and transcript tracking, media and camera catalogues, MCP server
registry, multi-provider failover, and visual agent chatflows built on LangGraph.js.

Status: under construction. G1 (scaffold) provides the admin console shell, authentication,
database, encrypted secrets and `/health`. See [docs/spec.md](docs/spec.md) for the agreed design.

## Quick start (Docker Compose)

```bash
cp .env.example .env
# edit .env: set GATEWAY_ENCRYPTION_KEY, ADMIN_USERNAME and ADMIN_PASSWORD
# a key can be generated with:  openssl rand -base64 32
docker compose up -d --build
```

Open <http://localhost:3000> and sign in with the admin credentials (HTTP Basic auth).
Check `curl http://localhost:3000/health`. Database migrations run automatically at start.
For a public host with automatic HTTPS, see [docs/deployment.md](docs/deployment.md).

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

All configuration is through environment variables. The table in
[docs/spec.md section 6](docs/spec.md#6-environment-variables) lists each variable and
whether it is required; [`.env.example`](.env.example) documents every one.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development, production build, production server |
| `pnpm lint` / `pnpm format` | Biome check / format |
| `pnpm typecheck` | TypeScript (`tsc --noEmit`) |
| `pnpm test:unit` | Vitest unit tests |
| `pnpm test:integration` | Vitest + Testcontainers Postgres (needs Docker) |
| `pnpm test:e2e` | Playwright smoke tests against a running app |
| `pnpm db:generate` / `db:migrate` / `db:studio` | Drizzle migrations and studio |
| `pnpm secrets:genkey` | Print a fresh base64 `GATEWAY_ENCRYPTION_KEY` |
| `pnpm secrets:rotate` | Re-encrypt stored secrets under `NEW_GATEWAY_ENCRYPTION_KEY` |

## License

MIT — see [LICENSE](LICENSE).
