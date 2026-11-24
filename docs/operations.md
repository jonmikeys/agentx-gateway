# Operations

Running notes for a deployed gateway: key rotation, data retention, logs, health checks,
upgrades and admin rate limiting. For installation and backups see
[deployment.md](deployment.md).

## Rotating the encryption key

`GATEWAY_ENCRYPTION_KEY` encrypts every secret stored in the database (AES-256-GCM). Rotation
re-encrypts those values under a new key.

**What is covered.** Exactly the columns registered in `src/server/crypto/encrypted-columns.ts`:

| Table.column | Holds |
|---|---|
| `providers.api_key` | provider API keys |
| `providers.extra_headers` | provider extra headers |
| `cameras.credentials` | camera username and password |
| `mcp_servers.headers` | MCP server headers |
| `flow_webhook_secrets.value` | webhook node header values |

Not covered, because they are not encrypted with this key: client API keys (stored as SHA-256
hashes and never recoverable), and `ADMIN_USERNAME` / `ADMIN_PASSWORD` (environment only).
Rotation runs in one transaction: either every value is re-encrypted or none is. If any stored
value cannot be decrypted with the current key, the script reports "Rotation failed; no changes
were applied" and exits non-zero.

**Where to run it.** The production image is a Next.js standalone build. It does not contain
`tsx`, `scripts/rotate-secrets.ts` or the dev dependencies, so the script cannot run inside the
container. Run it from a checkout of the same release (`pnpm install` first) against the
database. In the Compose stack Postgres is not published on the host, so expose it on loopback
for the duration of the rotation.

**Procedure (Docker Compose).**

1. Back up the database and the current key (see [deployment.md](deployment.md#backups-and-restore)).
2. Generate the new key and store it somewhere safe. Rotation never prints it:

   ```bash
   pnpm -s secrets:genkey          # or: openssl rand -base64 32
   ```

3. Stop the app so nothing writes secrets with the old key mid-rotation:

   ```bash
   docker compose stop app
   ```

4. Temporarily publish Postgres on loopback with a `docker-compose.override.yml` (merge it with
   your existing override if you use the GHCR image), then restart Postgres:

   ```yaml
   services:
     postgres:
       ports:
         - "127.0.0.1:5432:5432"
   ```

   ```bash
   docker compose up -d postgres
   ```

5. From the checkout, run the rotation. Variables set in the shell take precedence over `.env`.
   Percent-encode reserved characters in the database password in the URL:

   ```bash
   export DATABASE_URL='postgres://agentx:<password>@127.0.0.1:5432/agentx'
   export GATEWAY_ENCRYPTION_KEY='<current key>'
   export NEW_GATEWAY_ENCRYPTION_KEY='<new key>'
   pnpm secrets:rotate
   # Re-encrypted N value(s) across 5 registered column(s).
   ```

   Both keys must be valid base64 32-byte keys and must differ.

6. In `.env`, set `GATEWAY_ENCRYPTION_KEY` to the new key and leave
   `NEW_GATEWAY_ENCRYPTION_KEY` empty. Delete the override file (or the `ports` entry), then:

   ```bash
   docker compose up -d --force-recreate postgres app
   ```

7. Check `docker compose logs app` for a clean start and test a provider in the CRM
   (**Providers**, test action). Keep the old key until you have verified this; discard it
   afterwards.

If rotation fails nothing has changed: fix the cause (usually a wrong current key) and retry.
If you restart the app with the new key before rotating, or rotate and then forget to switch the
key, stored secrets fail to decrypt until the matching key is in `GATEWAY_ENCRYPTION_KEY`.

**Without Docker** the same applies: set the three variables (in `.env` or the shell) and run
`pnpm secrets:rotate` from the checkout, then switch the key and restart.

## Retention and session lifecycle

Two settings on the **Settings** page control the lifecycle (defaults in brackets):

- **Idle timeout** (30 minutes, 1 to 10080): an active session with no request for this long
  becomes `expired` with `end_reason = idle`. This happens lazily when the next request arrives
  with that session id (it then gets `404 session_not_found`) and by a sweeper that runs every
  minute. Expired and ended sessions keep their transcripts.
- **Retention** (90 days, 0 to 3650): sessions whose last activity is older than this are
  **hard-deleted**. `0` keeps everything.

The purge runs once an hour in the app process (first pass right after start), and on demand
via `POST /api/admin/sessions/maintenance`. It deletes the session and, by cascade, its turns,
transcript items and linked request-log rows. Registered purge hooks also delete data keyed by
the session id: agent run logs, agent session memory and the LangGraph checkpoints. The
sweeper also flags one-shot sessions (one request) as standalone, which hides them from the
Sessions list by default.

The **Redact emails and phone numbers** setting masks them as `[email]` / `[phone]` before a
transcript is saved. It applies to new messages only; nothing stored is rewritten. Deleting a
session in the CRM, individually or in bulk, hard-deletes it the same way. Media files and
camera entries are not touched by retention. Details:
[sessions-and-transcripts.md](sessions-and-transcripts.md#retention-redaction-and-deletion).

## Logs

The app writes one JSON object per line to stdout (errors and warnings go to stderr):
`{"time":"...","level":"info","msg":"...", ...fields}`. Read them with
`docker compose logs -f app`. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`) sets the minimum.

Transcript text, prompts, tool arguments and secrets are never logged: log fields are IDs,
timings and error codes. Environment errors name the variable, not its value. Per-request
details (route, provider attempts, timings, token usage) are stored in the database and shown in
the CRM request log; those rows contain no message content either. Notable messages:
`Database migrations applied`, `Session maintenance` (counts of expired, standalone and purged
sessions), `Purge hook failed` and the plain-HTTP warning below. Docker keeps container logs
without a size limit by default; configure a `json-file` `max-size` or a log driver on a
long-running host.

## Health checks

`GET /health` needs no authentication and returns `{"ok":true,"db":true,"version":"0.2.0"}`
with `200`, or `{"ok":false,"db":false,...}` with `503` when Postgres is unreachable. The
container `HEALTHCHECK` calls it every 30 seconds, so `docker compose ps` shows `healthy` or
`unhealthy`. Point an external uptime monitor at `/health` on the public URL. The endpoint
checks the database, not upstream providers: use **Providers** (test) and the dashboard for
provider health.

## Upgrading

Back up, pull a new image tag or `git pull`, and `docker compose up -d`. Migrations apply at
start. The full procedure and rollback notes are in
[deployment.md](deployment.md#upgrades).

## Admin access: rate limiting and plain HTTP

The CRM and `/api/admin/*` use HTTP Basic auth. Failed sign-ins are rate limited per client
address: 10 failures within 5 minutes block that address for 5 minutes (HTTP `429` with
`Retry-After`). The state is in memory, so it resets on restart and is not shared between
processes. The client address comes from `X-Forwarded-For`, which the bundled Caddy sets to the
real address; that is why the app port binds to `127.0.0.1` by default. Do not expose the app
port directly to untrusted networks, because a client could forge the header.

Basic auth sends the password with every request, so use TLS for anything beyond loopback or a
trusted LAN. At start the gateway logs a warning if `PUBLIC_BASE_URL` is `http://` on a
non-loopback host. It cannot detect plain HTTP when `PUBLIC_BASE_URL` is unset, so set it.
Client API keys have their own limits (requests per minute, tokens per day, IP allowlist); see
[api-keys.md](api-keys.md).
