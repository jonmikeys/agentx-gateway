#!/bin/sh
# Compose cannot percent-encode a variable inside an interpolated string, so build
# DATABASE_URL here from the discrete Postgres settings. Each component is URI
# encoded, so passwords containing @, :, /, %, ?, # or a space still parse.
set -eu

if [ -n "${POSTGRES_HOST:-}" ]; then
  DATABASE_URL=$(node -e '
    const encode = encodeURIComponent;
    const user = encode(process.env.POSTGRES_USER || "agentx");
    const password = encode(process.env.POSTGRES_PASSWORD || "agentx");
    const host = process.env.POSTGRES_HOST;
    const port = process.env.POSTGRES_PORT || "5432";
    const database = encode(process.env.POSTGRES_DB || "agentx");
    process.stdout.write(`postgres://${user}:${password}@${host}:${port}/${database}`);
  ')
  export DATABASE_URL
fi

exec "$@"
