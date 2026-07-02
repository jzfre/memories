import { z } from "zod";

const ScopeSchema = z.object({
  namespaces: z.union([z.literal("*"), z.array(z.string())]).default("*"),
  sensitivities: z.union([z.literal("*"), z.array(z.string())]).default("*"),
});

const ConnectorSchema = z.object({
  transport: z.enum(["stdio", "http"]),
  auth: z.enum(["none", "token", "oauth"]).default("none"),
  capabilities: z.array(z.enum(["read", "write"])).default(["read"]),
  scope: ScopeSchema.default({ namespaces: "*", sensitivities: "*" }),
  public_base_url: z.string().optional(),
});

const NoteRulesSchema = z.object({
  severities: z.record(z.enum(["block", "flag"])).default({}),
  quarantine_invalid: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  vault: z.object({ root: z.string().min(1) }),
  policy: z.object({
    default_namespace: z.string().default("personal"),
    default_sensitivity: z.string().default("private"),
    allowed_namespaces: z.array(z.string()).min(1),
    allowed_sensitivity: z.array(z.string()).min(1),
  }),
  actor: z.string().default("local"),
  connectors: z.record(ConnectorSchema).default({}),
  note_rules: NoteRulesSchema.default({ severities: {}, quarantine_invalid: false }),
});
export type Config = z.infer<typeof ConfigSchema>;

export const SearchInput = z.object({
  query: z.string().min(1),
  namespaces: z.array(z.string()).optional(),
  sensitivity_allowed: z.array(z.string()).optional(),
  top_k: z.number().int().positive().max(50).default(10),
});
export type SearchInput = z.infer<typeof SearchInput>;

export const SearchResultSource = z.object({
  path: z.string(),
  kind: z.string(),
  confidence: z.string().nullable(),
  status: z.string(),
  review_state: z.string().nullable(),
});

export const Freshness = z.object({
  validation: z.enum(["valid", "incomplete", "invalid"]),
  embedding: z.enum(["disabled", "pending", "current", "stale", "error"]),
});
export type Freshness = z.infer<typeof Freshness>;

export const SearchResult = z.object({
  document_id: z.string(),
  chunk_id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  source: SearchResultSource,
  freshness: Freshness,
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResponse = z.object({
  results: z.array(SearchResult),
  trace_id: z.string(),
  safety_note: z.string(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const FetchInput = z.object({ document_id: z.string().min(1) });
export type FetchInput = z.infer<typeof FetchInput>;
