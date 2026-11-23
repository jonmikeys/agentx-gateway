# Deployment guide

The gateway ships as a Docker Compose stack: `app` (Next.js standalone, non-root), `postgres`
(17, named volume) and an optional `caddy` reverse proxy for automatic HTTPS.

## Warning: HTTP basic auth

The admin console uses HTTP Basic authentication. Over plain `http://` the username and
password are sent in clear text on every request. Only use plain HTTP on a trusted local
network or loopback. For anything reachable from the internet, terminate TLS (see
"Cloud VM with HTTPS"). The server logs a warning at start when `PUBLIC_BASE_URL` is `http://`
on a non-loopback host.

## Self-hosted (LAN, plain HTTP)

```bash
cp .env.example .env
# set GATEWAY_ENCRYPTION_KEY (openssl rand -base64 32), ADMIN_USERNAME, ADMIN_PASSWORD
# optional: PUBLIC_BASE_URL=http://gateway.lan:3000, POSTGRES_PASSWORD=<something random>
docker compose up -d --build
curl http://localhost:3000/health     # {"ok":true,"db":true,"version":"..."}
```

The app port binds to `127.0.0.1` by default. To reach it from another machine on a trusted
LAN, set `GATEWAY_BIND_ADDRESS=0.0.0.0` in `.env`; anyone who can reach that port directly can
spoof `X-Forwarded-For`, so keep it off untrusted networks and prefer the Caddy profile below.

`DATABASE_URL` in `.env` is ignored by Compose: the app container always connects to the
bundled `postgres` service using `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
(default `agentx`). `docker-entrypoint.sh` builds the connection string and percent-encodes
each component, so reserved characters in the password are safe. Migrations apply on every
start. Uploaded media lives in the `media-data` volume mounted at `/data/media`.

Back up the `GATEWAY_ENCRYPTION_KEY` together with database backups; the database alone is
useless for restoring provider keys and other secrets without it.

## Cloud VM with HTTPS (Caddy)

1. Point a DNS `A`/`AAAA` record for your domain at the VM and open ports 80 and 443.
2. In `.env` set `GATEWAY_DOMAIN=gateway.example.com` and
   `PUBLIC_BASE_URL=https://gateway.example.com`, plus the required variables.
3. Start with the `tls` profile:

   ```bash
   docker compose --profile tls up -d --build
   ```

Caddy obtains and renews Let's Encrypt certificates automatically (state in the `caddy-data`
volume) and proxies to `app:3000` with response buffering disabled so streamed (SSE) replies
arrive token by token.

The app port binds to `127.0.0.1` by default, so only Caddy (80/443) should be public. Caddy
replaces `X-Forwarded-For` with the real client address, which the admin failed-login limiter
uses to identify clients; Caddy's value is used instead of any client-supplied prefix.

## Backups

```bash
# dump (custom format, compressed)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > agentx-$(date +%F).dump

# restore into an empty database
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < agentx-2026-01-01.dump
```

Also back up the `media-data` volume once uploads exist (G5), and keep a copy of
`GATEWAY_ENCRYPTION_KEY` outside the server.

## Upgrades

```bash
git pull
docker compose up -d --build     # migrations run automatically at start
```

## Rotating the encryption key

Take a backup, then run `pnpm secrets:rotate` as described in
[development.md](development.md#secrets-and-key-rotation) against the same database, set the
new `GATEWAY_ENCRYPTION_KEY`, and restart the stack.

## Operational notes

- Health: `GET /health` is unauthenticated and returns 503 with `"db":false` when Postgres is
  unreachable. The container `HEALTHCHECK` uses it.
- Single Node process: horizontal scaling is not supported in v0.1.
- Logs are JSON lines on stdout (`docker compose logs -f app`); `LOG_LEVEL` controls verbosity.
