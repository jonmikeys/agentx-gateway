import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions, transcriptItems, turns } from "@/server/db/schema";
import type { RequestOutcome } from "@/server/gateway/llm-proxy";
import { diffNewItems, hashSystemPrompt } from "@/server/gateway/transcript/diff";
import { redactText, redactValue } from "@/server/gateway/transcript/redaction";
import { ServiceError } from "@/server/services/errors";
import { recordLlmRequest } from "@/server/services/llm-requests";
import { getSessionSettings } from "@/server/services/session-settings";

/** Header carrying the session id in both directions (Unity session protocol). */
export const SESSION_HEADER = "X-Session-Id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveSessionInput {
  /** Raw `X-Session-Id` request header, if any. */
  headerValue: string | undefined;
  apiKeyId: string;
  routeSlug: string;
  /** Requested agent (G7a). A different agent than the session's ends it and starts a new one. */
  agentId: string | null;
}

/** `undefined` means the client's id is unknown, expired or ended: answer 404 session_not_found. */
export interface ResolvedSession {
  sessionId: string;
  isNew: boolean;
}

async function createSession(input: ResolveSessionInput): Promise<string> {
  const id = randomUUID();
  await getDb().insert(sessions).values({
    id,
    apiKeyId: input.apiKeyId,
    routeSlug: input.routeSlug,
    agentId: input.agentId,
  });
  return id;
}

/**
 * Applies the session contract to a chat request: no header creates a session, a header
 * continues an active one, anything else is `undefined` (404). Idle sessions are expired lazily.
 */
export async function resolveSession(
  input: ResolveSessionInput,
): Promise<ResolvedSession | undefined> {
  const headerValue = input.headerValue?.trim();
  if (!headerValue) return { sessionId: await createSession(input), isNew: true };
  if (!UUID_PATTERN.test(headerValue)) return undefined;

  const db = getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, headerValue), eq(sessions.apiKeyId, input.apiKeyId)));
  if (!session || session.status !== "active") return undefined;

  const { idle_timeout_minutes: idleMinutes } = await getSessionSettings();
  const idleMs = Date.now() - session.lastActivityAt.getTime();
  if (idleMs > idleMinutes * 60_000) {
    await endSessionRow(session.id, "expired", "idle");
    return undefined;
  }

  if ((session.agentId ?? null) !== input.agentId) {
    await endSessionRow(session.id, "ended", "agent_changed");
    return { sessionId: await createSession(input), isNew: true };
  }

  await db
    .update(sessions)
    .set({ lastActivityAt: new Date(), routeSlug: input.routeSlug })
    .where(eq(sessions.id, session.id));
  return { sessionId: headerValue, isNew: false };
}

async function endSessionRow(
  id: string,
  status: "expired" | "ended",
  reason: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(sessions)
    .set({ status, endReason: reason, endedAt: new Date() })
    .where(and(eq(sessions.id, id), eq(sessions.status, "active")))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Admin action: the next client request with this id gets 404 session_not_found. */
export async function endSession(id: string): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new ServiceError(404, "not_found", "Session not found");
  const [row] = await getDb()
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, id));
  if (!row) throw new ServiceError(404, "not_found", "Session not found");
  if (!(await endSessionRow(id, "ended", "admin"))) {
    throw new ServiceError(409, "session_not_active", `Session is already ${row.status}`);
  }
}

export interface PersistTurnInput {
  sessionId: string;
  apiKeyId: string;
  /** The request's `messages` array exactly as the client sent it. */
  messages: unknown[];
  outcome: RequestOutcome;
}

type NewItem = typeof transcriptItems.$inferInsert;

/**
 * Stores what is new in one request: the diffed client items, the assistant output, the
 * request row and the turn bookkeeping, in one transaction. Locks the session row so
 * concurrent requests number their items consistently.
 */
export async function persistRequest(input: PersistTurnInput): Promise<void> {
  const { redaction_enabled: redact } = await getSessionSettings();
  const clean = (text: string) => (redact ? redactText(text) : text);
  const cleanValue = (value: unknown) => (redact ? redactValue(value) : value);

  await getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for("update");
    if (!session) return;

    const [existing] = await tx
      .select({ one: sql<number>`1` })
      .from(transcriptItems)
      .where(
        and(
          eq(transcriptItems.sessionId, input.sessionId),
          sql`${transcriptItems.kind} <> 'system_prompt'`,
        ),
      )
      .limit(1);
    const diff = diffNewItems(input.messages, existing === undefined);

    const [latestTurn] = await tx
      .select()
      .from(turns)
      .where(eq(turns.sessionId, input.sessionId))
      .orderBy(desc(turns.seq))
      .limit(1);

    let turnId = latestTurn?.id;
    let turnCount = session.turnCount;
    if (diff.startsTurn || !latestTurn) {
      const [created] = await tx
        .insert(turns)
        .values({ sessionId: input.sessionId, seq: (latestTurn?.seq ?? 0) + 1 })
        .returning({ id: turns.id });
      turnId = created.id;
      if (diff.startsTurn) turnCount += 1;
    }
    if (!turnId) return;

    const requestId = await recordLlmRequest(
      input.apiKeyId,
      input.outcome,
      { sessionId: input.sessionId, turnId },
      tx,
    );

    const [{ lastSeq }] = await tx
      .select({ lastSeq: sql<number>`coalesce(max(${transcriptItems.seq}), 0)::int` })
      .from(transcriptItems)
      .where(eq(transcriptItems.sessionId, input.sessionId));

    // Tool results only carry the call id; resolve the tool name from earlier calls.
    const resultIds = diff.items.flatMap((item) =>
      item.kind === "tool_result" && item.toolCallId ? [item.toolCallId] : [],
    );
    const knownCalls =
      resultIds.length === 0
        ? []
        : await tx
            .select({ id: transcriptItems.toolCallId, name: transcriptItems.toolName })
            .from(transcriptItems)
            .where(
              and(
                eq(transcriptItems.sessionId, input.sessionId),
                eq(transcriptItems.kind, "tool_call"),
                inArray(transcriptItems.toolCallId, resultIds),
              ),
            );
    const toolNames = new Map(knownCalls.map((call) => [call.id, call.name]));

    const rows: Omit<NewItem, "seq" | "turnId" | "sessionId" | "llmRequestId">[] = [];

    const promptHash = diff.systemPrompt === null ? null : hashSystemPrompt(diff.systemPrompt);
    const promptChanged = promptHash !== null && promptHash !== session.systemPromptHash;
    if (promptChanged && diff.systemPrompt !== null) {
      rows.push({ kind: "system_prompt", content: clean(diff.systemPrompt) });
    }

    for (const item of diff.items) {
      rows.push({
        kind: item.kind,
        content: clean(item.content),
        toolCallId: item.toolCallId ?? null,
        toolName:
          item.toolName ?? (item.toolCallId ? (toolNames.get(item.toolCallId) ?? null) : null),
        toolArgs: item.kind === "tool_call" ? cleanValue(item.toolArgs ?? null) : null,
        toolSource: item.kind === "tool_call" ? "client" : null,
      });
    }

    const captured = input.outcome.captured;
    if (captured?.reasoning) rows.push({ kind: "reasoning", content: clean(captured.reasoning) });
    if (captured?.text) rows.push({ kind: "assistant_message", content: clean(captured.text) });
    for (const call of captured?.toolCalls ?? []) {
      rows.push({
        kind: "tool_call",
        content: "",
        toolCallId: call.id ?? null,
        toolName: call.name ?? null,
        toolArgs: cleanValue(call.args),
        toolSource: "client",
      });
    }
    const errorText = captured?.error ?? input.outcome.errorMessage;
    const failed = input.outcome.status === "error" && input.outcome.errorCode !== "client_closed";
    if (failed || captured?.error) {
      const code = input.outcome.errorCode ?? "upstream_error";
      rows.push({ kind: "error", content: clean(errorText ? `${code}: ${errorText}` : code) });
    }

    if (rows.length > 0) {
      await tx.insert(transcriptItems).values(
        rows.map((row, index) => ({
          ...row,
          seq: lastSeq + index + 1,
          turnId,
          sessionId: input.sessionId,
          llmRequestId: requestId,
        })),
      );
    }

    const now = new Date();
    await tx.update(turns).set({ completedAt: now }).where(eq(turns.id, turnId));
    await tx
      .update(sessions)
      .set({
        turnCount,
        lastActivityAt: now,
        systemPromptHash: promptHash ?? session.systemPromptHash,
      })
      .where(eq(sessions.id, input.sessionId));
  });
}
