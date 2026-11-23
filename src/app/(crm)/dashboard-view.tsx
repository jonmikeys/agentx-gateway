"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/crm/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCount, formatDuration } from "@/lib/format";
import type { DashboardStats } from "@/lib/session-types";

const activityConfig = {
  sessions: { label: "Sessions", color: "var(--chart-1)" },
  turns: { label: "Turns", color: "var(--chart-2)" },
} satisfies ChartConfig;

const problemsConfig = {
  failovers: { label: "Failovers", color: "var(--chart-1)" },
  errors: { label: "Errors", color: "var(--destructive)" },
} satisfies ChartConfig;

const tokensConfig = {
  tokens: { label: "Tokens", color: "var(--chart-3)" },
} satisfies ChartConfig;

function StatCard({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

function shortDay(day: string): string {
  return day.slice(5);
}

export function DashboardView({ stats }: { stats: DashboardStats }) {
  const hasProviderTokens = stats.tokens_per_provider.length > 0;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Active sessions, usage, failovers and provider health at a glance."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Active sessions now"
          value={formatCount(stats.active_sessions)}
          hint="Not yet idle-expired or ended"
        />
        <StatCard
          title="Sessions today"
          value={formatCount(stats.sessions_today)}
          hint="Started since 00:00 UTC"
        />
        <StatCard
          title="Turns today"
          value={formatCount(stats.turns_today)}
          hint="User turns since 00:00 UTC"
        />
        <StatCard
          title="Tokens today"
          value={formatCount(stats.tokens_today)}
          hint="Prompt plus completion"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sessions and turns per day</CardTitle>
            <CardDescription>Last 14 days (UTC)</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={activityConfig} className="h-64 w-full">
              <BarChart data={stats.per_day} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="sessions" fill="var(--color-sessions)" radius={3} />
                <Bar dataKey="turns" fill="var(--color-turns)" radius={3} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Failovers and errors per day</CardTitle>
            <CardDescription>
              A failover is a request answered after another provider failed or was skipped.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={problemsConfig} className="h-64 w-full">
              <LineChart data={stats.per_day} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="failovers"
                  stroke="var(--color-failovers)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line dataKey="errors" stroke="var(--color-errors)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tokens per provider</CardTitle>
            <CardDescription>Last 14 days, by the provider that answered</CardDescription>
          </CardHeader>
          <CardContent>
            {hasProviderTokens ? (
              <ChartContainer config={tokensConfig} className="h-64 w-full">
                <BarChart data={stats.tokens_per_provider} layout="vertical" accessibilityLayer>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="provider"
                    width={96}
                    tickLine={false}
                    axisLine={false}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="tokens" fill="var(--color-tokens)" radius={3} />
                </BarChart>
              </ChartContainer>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No token usage recorded yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Slowest providers</CardTitle>
            <CardDescription>Successful requests in the last 24 hours</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Avg TTFT</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.slowest_providers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No requests in the last 24 hours.
                    </TableCell>
                  </TableRow>
                ) : (
                  stats.slowest_providers.map((provider) => (
                    <TableRow key={provider.provider}>
                      <TableCell className="font-medium">{provider.provider}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(provider.requests)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDuration(provider.avg_ttft_ms)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDuration(provider.avg_latency_ms)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
