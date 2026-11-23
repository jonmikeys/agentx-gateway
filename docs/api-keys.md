# Client API keys

The client API (`/v1/*` and `/agents`) requires a gateway-issued key; `/health` and `GET /v1/openapi.json` stay public.

```
Authorization: Bearer agx_<32 random base62 characters>
```

## Lifecycle

- Create keys on the **API Keys** page (or `POST /api/admin/api-keys`). The full key is shown
  **once** in the creation response and dialog. Only its SHA-256 hash and a display prefix
  (`agx_ab12`) are stored, so a lost key cannot be recovered: revoke it and create a new one.
- Give each client its own labelled key (for example "Lobby kiosk").
- **Revoke** disables a key immediately; revoked keys answer `401 invalid_api_key`. Editing a key
  (label, allowlist, limits) also takes effect immediately. Lookups are cached in memory for at
  most 30 s and the cache is invalidated on revoke and update in this process.
- `last_used_at` is updated at most once a minute per key.

## IP allowlist

A key can carry a list of IPs and CIDR ranges (IPv4 and IPv6, e.g. `203.0.113.0/24`,
`2001:db8::/32`). An empty list allows any address. A request from an address outside the list
gets `403 ip_not_allowed`.

**The allowlist needs a reverse proxy.** Next.js route handlers do not expose the socket address,
so the gateway reads the client IP from the first entry of `X-Forwarded-For`, falling back to
`X-Real-IP`. Run it behind a proxy that sets those headers, such as the bundled Caddy profile
(`docker compose --profile tls up`, see [deployment.md](deployment.md)). Make sure the proxy
overwrites client-supplied forwarding headers and that the app port is not reachable directly:
otherwise a client can forge the header. If a key has an allowlist and no valid IP can be
determined, the request is **denied**.

## Rate limits

Both limits are optional and tracked in Postgres, so they survive restarts.

| Limit | Behaviour |
|---|---|
| `rpm_limit` (requests per minute) | Counted per UTC minute. Checked before the request is processed; over the limit returns `429 rate_limit_exceeded` with `Retry-After` set to the seconds until the next minute |
| `tokens_per_day_limit` | Checked before the request against the UTC day's recorded usage; tokens from the upstream `usage` are added after the request finishes. Once the total reaches the limit further requests return `429` with `Retry-After` until midnight UTC. A single request may overshoot the limit because its size is only known afterwards |

## Errors

| Status | `error.code` | Cause |
|---|---|---|
| 401 | `invalid_api_key` | Missing, malformed, unknown or revoked key |
| 403 | `ip_not_allowed` | Client IP outside the allowlist |
| 429 | `rate_limit_exceeded` | A limit above was exceeded |

See [providers-and-routes.md](providers-and-routes.md) for the rest of the client API errors.

## Admin API

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/api-keys` | List keys (prefix, limits, allowlist, `revoked_at`, `last_used_at`; never the key) |
| `POST /api/admin/api-keys` | Create; body `label`, optional `ip_allowlist`, `rpm_limit`, `tokens_per_day_limit`. The response alone contains `key` |
| `PATCH /api/admin/api-keys/{id}` | Update label, allowlist or limits |
| `POST /api/admin/api-keys/{id}/revoke` | Revoke |
