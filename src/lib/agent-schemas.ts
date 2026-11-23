import { z } from "zod";
import { flowGraphSchema, flowKindSchema } from "@/lib/agents/graph";

/** Zod schemas shared by the flows admin API and the CRM editor. */

const slugSchema = z
  .string()
  .trim()
  .min(1, "Slug is required")
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, dots, dashes and underscores");

const flowSettingsSchema = z.object({
  default_route_slug: z.string().trim().min(1).max(120).nullable().default(null),
  allowed_media_tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  allowed_cameras: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
});

export const flowCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: slugSchema.optional(),
  kind: flowKindSchema.default("agent"),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  settings: flowSettingsSchema.partial().optional(),
});

export const flowUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  settings: flowSettingsSchema.partial().optional(),
});

export const flowDraftSchema = z.object({
  graph: flowGraphSchema,
  /** The `draft_updated_at` the client opened; a newer stored value returns a conflict warning. */
  base_draft_updated_at: z.iso.datetime({ offset: true }).optional(),
});

export const flowPublishSchema = z.object({
  note: z.string().trim().max(500).default(""),
});

export const flowTestRunSchema = z.object({
  input: z.string().trim().min(1, "Enter a message").max(20_000),
  stream: z.boolean().default(false),
});

export type FlowCreateInput = z.infer<typeof flowCreateSchema>;
export type FlowUpdateInput = z.infer<typeof flowUpdateSchema>;
export type FlowDraftInput = z.infer<typeof flowDraftSchema>;
export type FlowPublishInput = z.infer<typeof flowPublishSchema>;
export type FlowSettingsInput = z.infer<typeof flowSettingsSchema>;
