# Deployment guide

The gateway ships as a Docker Compose stack with three services:

| Service | Image | Notes |
|---|---|---|
| `app` | built from the `Dockerfile` (`agentx-gateway:local`) or the published GHCR image | Next.js standalone server, non-root user, port 3000 inside the container |
| `postgres` | `postgres:17` | Data in the `postgres-data` volume; not published on the host |
| `caddy` | `caddy:2` | Only with the `tls` profile: automatic HTTPS in front of `app` |
| `searxng` | `searxng/searxng` (pinned tag) | Only with the `search` profile: web search backend for the built-in tools, internal network only. See [web-search.md](web-search.md) |

The app image also bundles **yt-dlp** (pinned in the `Dockerfile`) for playing videos found by
`video_search`; it changes only with gateway releases.

Volumes: `postgres-data` (database), `media-data` (uploads, mounted at `/data/media`),
`caddy-data` and `caddy-config` (certificates and Caddy state). Compose prefixes volume names
with the project name (by default the directory name), for example `agentx-gateway_media-data`.

For operating the running gateway (key rotation, retention, logs) see
[operations.md](operations.md). Every variable is listed in the [README](../README.md#configuration).

## Warning: HTTP basic auth

The admin console uses HTTP Basic authentication. Over plain `http://` the username and
password are sent in clear text on every request. Only use plain HTTP on a trusted local
network or loopback. For anything reachable from the internet, terminate TLS (see
"Cloud VM with HTTPS"). The server logs a warning at start when `PUBLIC_BASE_URL` is `http://`
on a non-loopback host.

## Self-hosted (LAN box, plain HTTP)

```bash
cp .env.example .env
# set GATEWAY_ENCRYPTION_KEY (openssl rand -base64 32), ADMIN_USERNAME, ADMIN_PASSWORD
# optional: PUBLIC_BASE_URL=http://gateway.lan:3000, POSTGRES_PASSWORD=<something random>
docker compose up -d --build
curl http://localhost:3000/health     # {"ok":true,"db":true,"version":"..."}
```

The app port binds to `127.0.0.1` by default. To reach it from another machine on a trusted
LAN, set `GATEWAY_BIND_ADDRESS=0.0.0.0` in `.env` (and optionally `GATEWAY_PORT`), then
`docker compose up -d`. Anyone who can reach that port directly can spoof `X-Forwarded-For`, so
keep it off untrusted networks and prefer the Caddy profile below. Set `PUBLIC_BASE_URL` to the
address clients use (for example `http://192.168.1.20:3000`) so media `content_url` values are
absolute and correct.

`DATABASE_URL` in `.env` is ignored by Compose: the app container always connects to the
bundled `postgres` service using `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
(default `agentx`). `docker-entrypoint.sh` builds the connection string and percent-encodes
each component, so reserved characters in the password are safe. Migrations apply on every
start. Uploaded media lives in the `media-data` volume mounted at `/data/media`.

Back up `GATEWAY_ENCRYPTION_KEY` together with database backups; the database alone is
useless for restoring provider keys and other secrets without it.

## Cloud VM with HTTPS (Caddy)

1. Create a VM with Docker and Compose, and a DNS `A` (and `AAAA`) record for your domain that
   points at its public address. DNS must resolve before the first start, or certificate
   issuance fails.
2. Firewall / security group: allow inbound TCP 80 and 443 (and UDP 443 for HTTP/3) and SSH.
   Do **not** open port 3000 or 5432: the app port binds to `127.0.0.1` by default and Postgres
   is not published at all. Leave `GATEWAY_BIND_ADDRESS` at its default so that Caddy is the only
   public path.
3. In `.env` set `GATEWAY_DOMAIN=gateway.example.com` and
   `PUBLIC_BASE_URL=https://gateway.example.com`, plus the required variables and a random
   `POSTGRES_PASSWORD`.
4. Start with the `tls` profile:

   ```bash
   docker compose --profile tls up -d --build
   ```

Caddy obtains and renews Let's Encrypt certificates automatically (state in the `caddy-data`
volume) and proxies to `app:3000` with response buffering disabled so streamed (SSE) replies
arrive token by token. Without `GATEWAY_DOMAIN`, Caddy serves `localhost` with a locally
trusted certificate, which is useful for a trial run only.

Caddy replaces `X-Forwarded-For` with the real client address. The admin failed-login limiter
and API key IP allowlists identify clients through it, so a client-supplied prefix cannot be
used to evade them. Clients then use `https://gateway.example.com/v1` as their base URL.

Always pass `--profile tls` on later commands too (`docker compose --profile tls up -d`,
`docker compose --profile tls logs caddy`), or Compose ignores the `caddy` service.

## Using the published image

Tagged releases (`v*`) are published to the GitHub Container Registry as
`ghcr.io/jonmikeys/agentx-gateway` with the tags `<version>` (for example `0.2.0`),
`<major>.<minor>` (`0.2`) and `latest`. Pin a version in production rather than `latest`.

`docker-compose.yml` builds locally by default. To run the published image instead, add a
`docker-compose.override.yml` next to it (Compose loads it automatically). `build: !reset null`
drops the local build and needs Compose 2.24 or newer:

```yaml
services:
  app:
    image: ghcr.io/jonmikeys/agentx-gateway:0.2.0
    build: !reset null
    pull_policy: always
```

Then:

```bash
docker compose pull app
docker compose up -d            # add --profile tls for HTTPS
```

If the package is private, run `docker login ghcr.io` first with a token that has
`read:packages`.

## Upgrades

Back up first (see below), then:

```bash
# built from source
git pull
docker compose up -d --build

# published image: change the tag in docker-compose.override.yml, then
docker compose pull app
docker compose up -d
```

Migrations run automatically when the new container starts (the process exits if one fails);
no separate step is needed. If a migration or the environment is invalid, the process
logs the error and exits, and `docker compose logs app` shows the reason. Migrations only
move forward: to roll back to an older image after a schema change, restore the database
backup taken before the upgrade. Read the [CHANGELOG](../CHANGELOG.md) before upgrading.

## Backups and restore

State lives in three places: the Postgres database, the `media-data` volume, and the
`GATEWAY_ENCRYPTION_KEY` in your `.env`. Back up all three and keep the key outside the server.

```bash
# database dump (custom format, compressed)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > agentx-$(date +%F).dump

# media files (the app image contains tar)
docker compose exec -T app tar czf - -C /data/media . > agentx-media-$(date +%F).tar.gz
```

Restore into the same stack (stop the app so nothing writes during the restore):

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < agentx-2026-01-01.dump
docker compose up -d app

# media (the app container must be running)
docker compose exec -T app tar xzf - -C /data/media < agentx-media-2026-01-01.tar.gz
```

A plain-SQL dump works too: use `pg_dump` without `-Fc` and restore with
`psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"` fed from stdin. To restore on a new host, bring
up the stack with the same `GATEWAY_ENCRYPTION_KEY`, restore, and start the app; with a
different key the stored provider keys, MCP headers, camera credentials and webhook headers
cannot be decrypted. Test a restore on a scratch machine before you need it.

## Operational notes

- Health: `GET /health` is unauthenticated and returns 503 with `"db":false` when Postgres is
  unreachable. The container `HEALTHCHECK` uses it.
- Single Node process: horizontal scaling is not supported in v0.1.
- Web search: `docker compose --profile search up -d` plus `SEARXNG_URL=http://searxng:8080` in
  `.env`. The gateway fetches pages, images and video streams from the internet on the model's
  behalf (public addresses only); allow outbound HTTPS from the app container.
- Logs are JSON lines on stdout (`docker compose logs -f app`); `LOG_LEVEL` controls verbosity.
- Key rotation, retention, and the admin rate limiter are covered in [operations.md](operations.md).
