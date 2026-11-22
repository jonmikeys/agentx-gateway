import { sql } from "drizzle-orm";
import type { DashboardStats } from "@/lib/session-types";
import { getDb } from "@/server/db/client";

const DAYS = 14;

type Row = Record<string, unknown>;

async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  return [...(await getDb().execute(query))] as Row[];
}

function toNumber(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Math.round(Number(value));
}

/** Dashboard numbers. "Today" and per-day buckets use UTC calendar days. */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [totals] = await rows(sql`
    select
      (select count(*)::int from sessions where status = 'active') as active_sessions,
      (select count(*)::int from sessions
         where started_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') as sessions_today,
      (select count(*)::int from turns
         where started_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') as turns_today,
      (select coalesce(sum((usage->>'total_tokens')::bigint), 0)::bigint from llm_requests
         where started_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') as tokens_today
  `);

  const perDay = await rows(sql`
    with days as (
      select generate_series(
        date_trunc('day', now() at time zone 'UTC') - make_interval(days => ${DAYS - 1}),
        date_trunc('day', now() at time zone 'UTC'),
        interval '1 day'
      ) as day
    )
    select
      to_char(days.day, 'YYYY-MM-DD') as day,
      (select count(*)::int from sessions s
         where date_trunc('day', s.started_at at time zone 'UTC') = days.day) as sessions,
      (select count(*)::int from turns t
         where date_trunc('day', t.started_at at time zone 'UTC') = days.day) as turns,
      (select count(*)::int from llm_requests r
         where date_trunc('day', r.started_at at time zone 'UTC') = days.day
           and r.status = 'ok' and jsonb_array_length(r.attempts) > 1) as failovers,
      (select count(*)::int from llm_requests r
         where date_trunc('day', r.started_at at time zone 'UTC') = days.day
           and r.status = 'error' and coalesce(r.error_code, '') <> 'client_closed') as errors
    from days
    order by days.day
  `);

  const perProvider = await rows(sql`
    select p.name as provider, coalesce(sum((r.usage->>'total_tokens')::bigint), 0)::bigint as tokens
    from llm_requests r
    join providers p on p.id = r.provider_id
    where r.started_at >= now() - make_interval(days => ${DAYS})
    group by p.name
    order by tokens desc
  `);

  const slowest = await rows(sql`
    select p.name as provider, count(*)::int as requests,
      avg(r.ttft_ms) as avg_ttft_ms, avg(r.duration_ms) as avg_latency_ms
    from llm_requests r
    join providers p on p.id = r.provider_id
    where r.started_at >= now() - interval '24 hours' and r.status = 'ok'
    group by p.name
    order by avg(r.ttft_ms) desc nulls last
    limit 10
  `);

  return {
    active_sessions: toNumber(totals?.active_sessions),
    sessions_today: toNumber(totals?.sessions_today),
    turns_today: toNumber(totals?.turns_today),
    tokens_today: toNumber(totals?.tokens_today),
    per_day: perDay.map((row) => ({
      day: String(row.day),
      sessions: toNumber(row.sessions),
      turns: toNumber(row.turns),
      failovers: toNumber(row.failovers),
      errors: toNumber(row.errors),
    })),
    tokens_per_provider: perProvider.map((row) => ({
      provider: String(row.provider),
      tokens: toNumber(row.tokens),
    })),
    slowest_providers: slowest.map((row) => ({
      provider: String(row.provider),
      requests: toNumber(row.requests),
      avg_ttft_ms: toNullableNumber(row.avg_ttft_ms),
      avg_latency_ms: toNullableNumber(row.avg_latency_ms),
    })),
  };
}
