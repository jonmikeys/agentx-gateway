import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Key/value settings (idle timeout, retention, ...). Populated by later stages. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
