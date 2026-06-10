import { randomUUID } from "node:crypto";
import { UNTRUSTED_CONTENT_NOTE } from "@memories/shared";
import { approxTokens } from "@memories/shared";
import { loadConfig } from "../config/index";
import { writeAudit } from "../audit/index";
import { search, type SearchDeps } from "./search";

export interface ContextPackInput {
  goal: string;
  namespaces?: string[];
  sensitivity_allowed?: string[];
  max_tokens?: number;
}

export interface ContextPackSection {
  title: string;
  content: string;
  sources: string[];
}

export interface ContextPack {
  context_pack_id: string;
  summary: string;
  sections: ContextPackSection[];
  warnings: string[];
  source_document_ids: string[];
  trace_id: string;
  safety_note: string;
}

const DEFAULT_MAX_TOKENS = 6000;

/**
 * Build a context pack from a goal query.
 *
 * - Delegates to search() for retrieval, scoping, tracing, and audit of the search.
 * - Groups results by source.kind into sections.
 * - Enforces max_tokens with approxTokens (truncates trailing sections, adds warning).
 * - Adds warnings for stale/incomplete freshness or pending-review items.
 * - Adds its own audit row for the context_pack action.
 * - Never throws on empty results.
 */
export async function buildContextPack(
  input: ContextPackInput,
  ctx: { client: string },
  deps: SearchDeps = {},
): Promise<ContextPack> {
  const maxTokens = input.max_tokens ?? DEFAULT_MAX_TOKENS;
  const { actor } = loadConfig();

  // Run search with top_k=20; reuses scope/trace/audit of search
  const searchResponse = await search(
    {
      query: input.goal,
      namespaces: input.namespaces,
      sensitivity_allowed: input.sensitivity_allowed,
      top_k: 20,
    },
    ctx,
    deps,
  );

  const results = searchResponse.results;
  const traceId = searchResponse.trace_id;
  const warnings: string[] = [];

  // ── Group results by source.kind ──────────────────────────────────────────
  const kindMap = new Map<string, typeof results>();
  for (const r of results) {
    const kind = r.source.kind;
    if (!kindMap.has(kind)) kindMap.set(kind, []);
    kindMap.get(kind)!.push(r);
  }

  // Build sections (not yet token-truncated)
  const rawSections: ContextPackSection[] = [];
  for (const [kind, items] of kindMap.entries()) {
    const title = kind.charAt(0).toUpperCase() + kind.slice(1) + "s";
    const lines = items.map((r) => `- **${r.title}**: ${r.snippet}`);
    const content = lines.join("\n");
    const sources = [...new Set(items.map((r) => r.document_id))];
    rawSections.push({ title, content, sources });
  }

  // ── Freshness / review-state warnings ────────────────────────────────────
  const invalidCount = results.filter((r) => r.freshness.validation !== "valid").length;
  if (invalidCount > 0) {
    warnings.push(`Includes ${invalidCount} notes with incomplete/invalid metadata.`);
  }

  const staleEmbedCount = results.filter((r) => r.freshness.embedding === "stale").length;
  if (staleEmbedCount > 0) {
    warnings.push(`Includes ${staleEmbedCount} notes with stale embeddings.`);
  }

  const pendingReviewCount = results.filter((r) => r.source.review_state === "pending_review").length;
  if (pendingReviewCount > 0) {
    warnings.push(`Includes ${pendingReviewCount} unreviewed items.`);
  }

  // ── Empty-results warning ─────────────────────────────────────────────────
  if (results.length === 0) {
    warnings.push("No results found for the given goal and scope.");
  }

  // ── Token budget enforcement ──────────────────────────────────────────────
  const finalSections: ContextPackSection[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const section of rawSections) {
    const sectionTokens = approxTokens(section.content);
    if (usedTokens + sectionTokens <= maxTokens) {
      finalSections.push(section);
      usedTokens += sectionTokens;
    } else {
      // Try to fit a partial section
      const remaining = maxTokens - usedTokens;
      if (remaining > 0) {
        // Truncate the content to fit remaining tokens (approx 4 chars/token)
        const maxChars = remaining * 4;
        const truncatedContent = section.content.slice(0, maxChars);
        // Only include complete lines
        const lastNewline = truncatedContent.lastIndexOf("\n");
        const fittedContent = lastNewline > 0 ? truncatedContent.slice(0, lastNewline) : truncatedContent;
        if (fittedContent.trim().length > 0) {
          finalSections.push({ ...section, content: fittedContent });
          usedTokens += approxTokens(fittedContent);
        }
      }
      truncated = true;
      break;
    }
  }

  if (truncated) {
    warnings.push(`Context truncated to ${usedTokens} tokens.`);
  }

  // ── Assemble pack ─────────────────────────────────────────────────────────
  const sourceDocumentIds = [...new Set(finalSections.flatMap((s) => s.sources))];
  const kindCount = finalSections.length;
  const sourceCount = sourceDocumentIds.length;

  const summary = `Context pack for: ${input.goal} — ${sourceCount} sources across ${kindCount} kinds.`;
  const contextPackId = `ctx_${randomUUID()}`;

  // Write context_pack audit row (separate from the search audit already written)
  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.context_pack",
    namespace: (input.namespaces ?? []).join(",") || "n/a",
    sensitivityRequested: (input.sensitivity_allowed ?? []).join(",") || null,
    inputs: input,
    returnedDocumentIds: sourceDocumentIds,
    approved: true,
  });

  return {
    context_pack_id: contextPackId,
    summary,
    sections: finalSections,
    warnings,
    source_document_ids: sourceDocumentIds,
    trace_id: traceId,
    safety_note: UNTRUSTED_CONTENT_NOTE,
  };
}
