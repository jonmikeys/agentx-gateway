import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";

let saverPromise: Promise<PostgresSaver | undefined> | undefined;

/**
 * LangGraph checkpointer backed by the gateway database (thread_id = session id). `setup()` is
 * idempotent and creates its own tables on first use. When the database is unavailable the agent
 * still runs, without checkpointing (logged once per process).
 */
export function getCheckpointer(): Promise<PostgresSaver | undefined> {
  saverPromise ??= (async () => {
    try {
      const saver = PostgresSaver.fromConnString(getEnv().DATABASE_URL);
      await saver.setup();
      return saver;
    } catch (error) {
      logger.warn("LangGraph checkpointer unavailable; continuing without checkpoints", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return undefined;
    }
  })();
  return saverPromise;
}

/** Tests that recreate the database can drop the cached instance. */
export function resetCheckpointerForTests(): void {
  saverPromise = undefined;
}
