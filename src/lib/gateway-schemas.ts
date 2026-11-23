import { z } from "zod";
import { isValidCidr } from "@/server/gateway/cidr";

/** Zod schemas shared by the admin API and the CRM forms. */

export const capabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  responses_api: z.boolean(),
});

const baseUrlSchema = z
  .string()
  .trim()
  .min(1, "Base URL is required")
  .refine(
    (value) => URL.canParse(value) && /^https?:/i.test(value),
    "Must be an absolute http(s) URL such as https://api.openai.com/v1",
  );

const headersSchema = z.record(z.string().trim().min(1), z.string());

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  base_url: baseUrlSchema,
  api_key: z.string().trim().min(1).nullish(),
  enabled: z.boolean().default(true),
  capabilities: capabilitiesSchema.default({ streaming: true, tools: true, responses_api: false }),
  extra_headers: headersSchema.nullish(),
});

/** On update, an absent `api_key` / `extra_headers` keeps the stored value; `null` clears it. */
export const providerUpdateSchema = providerCreateSchema.partial();

export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;

const slugSchema = z
  .string()
  .trim()
  .min(1, "Slug is required")
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, dots, dashes and underscores");

export const routeStepSchema = z.object({
  provider_id: z.uuid("Choose a provider"),
  upstream_model: z.string().trim().min(1, "Upstream model is required"),
  timeout_ms: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export const routeWriteSchema = z.object({
  slug: slugSchema.refine((value) => value !== "default", "'default' is reserved"),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
  steps: z.array(routeStepSchema).min(1, "Add at least one step").max(10),
});

export type RouteWriteInput = z.infer<typeof routeWriteSchema>;

const allowlistSchema = z
  .array(z.string().trim().min(1))
  .refine((entries) => entries.every(isValidCidr), "Each entry must be an IP or CIDR range");

const limitSchema = z.coerce.number().int().min(1).nullable();

export const apiKeyCreateSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  ip_allowlist: allowlistSchema.default([]),
  rpm_limit: limitSchema.default(null),
  tokens_per_day_limit: limitSchema.default(null),
});

export const apiKeyUpdateSchema = apiKeyCreateSchema.partial();

export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
export type ApiKeyUpdateInput = z.infer<typeof apiKeyUpdateSchema>;

/** Minimal chat-completions validation; every other field passes through upstream. */
export const chatCompletionRequestSchema = z.looseObject({
  messages: z.array(z.unknown()).min(1, "messages must be a non-empty array"),
  model: z.unknown().optional(),
  stream: z.boolean().optional(),
});

/** Minimal Responses validation; every other field passes through (native) or is dropped (translated). */
export const responsesRequestSchema = z.looseObject({
  input: z.union(
    [z.string().min(1), z.array(z.unknown()).min(1)],
    "input must be a non-empty string or array of items",
  ),
  model: z.unknown().optional(),
  stream: z.boolean().optional(),
  previous_response_id: z.unknown().optional(),
});

export const sessionSettingsSchema = z.object({
  idle_timeout_minutes: z.coerce.number().int().min(1).max(10_080),
  retention_days: z.coerce.number().int().min(0).max(3650),
  redaction_enabled: z.boolean(),
});

export const sessionStatusSchema = z.enum(["active", "expired", "ended"]);

/** Query filters shared by the session list, bulk export and bulk delete. */
export const sessionFiltersSchema = z.object({
  status: sessionStatusSchema.optional(),
  api_key_id: z.uuid().optional(),
  route: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  include_standalone: z.boolean().default(false),
  q: z.string().trim().min(1).max(200).optional(),
});

export type SessionFiltersInput = z.infer<typeof sessionFiltersSchema>;

export const sessionBulkDeleteSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(1000).optional(),
    filters: sessionFiltersSchema.optional(),
  })
  .refine((value) => (value.ids !== undefined) !== (value.filters !== undefined), {
    message: "Provide either ids or filters",
  });
