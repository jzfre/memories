/**
 * Embedding provider abstraction. The real provider talks to an OpenAI-compatible
 * /embeddings endpoint (LM Studio's nomic model by default). It is pluggable so tests
 * can inject a deterministic in-process embedder and never depend on an external LLM.
 *
 * Embeddings are a best-effort enhancement: when disabled or unreachable, search
 * silently falls back to full-text only. They are enabled via EMBEDDINGS_ENABLED so
 * the test suite (which does not set it) stays full-text-only and deterministic.
 */

export interface Embedder {
  /** Vector dimensionality, or 0 when disabled. */
  readonly dim: number;
  /** Model name identifier stored per chunk for provenance. */
  readonly model: string;
  /** Cheap liveness probe; false means "skip embeddings, use FTS only". */
  available(): Promise<boolean>;
  /** Embed document chunks (provider may apply a document task-prefix). */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embed a single query string (provider may apply a query task-prefix). */
  embedQuery(text: string): Promise<number[]>;
}

/** No-op provider: reports unavailable so callers fall back to full-text search. */
export class DisabledEmbedder implements Embedder {
  readonly dim = 0;
  readonly model = "disabled";
  async available(): Promise<boolean> {
    return false;
  }
  async embedDocuments(): Promise<number[][]> {
    return [];
  }
  async embedQuery(): Promise<number[]> {
    throw new Error("embeddings are disabled");
  }
}

/** Talks to an OpenAI-compatible embeddings endpoint (e.g. LM Studio). */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  constructor(
    private readonly baseUrl: string,
    model: string,
    readonly dim: number,
  ) {
    this.model = model;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputs }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }

  // nomic-embed-text uses task prefixes; they materially improve retrieval quality.
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embed(texts.map((t) => `search_document: ${t}`));
  }
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([`search_query: ${text}`]))[0];
  }
}

function enabled(): boolean {
  const v = process.env.EMBEDDINGS_ENABLED;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

/** The provider used at runtime: real when EMBEDDINGS_ENABLED is set, else disabled. */
export function getDefaultEmbedder(): Embedder {
  if (!enabled()) return new DisabledEmbedder();
  return new OpenAICompatibleEmbedder(
    process.env.EMBEDDINGS_URL ?? "http://localhost:1234/v1",
    process.env.EMBEDDINGS_MODEL ?? "text-embedding-nomic-embed-text-v1.5",
    Number(process.env.EMBEDDINGS_DIM ?? 768),
  );
}

/** Format a JS number[] as a pgvector text literal: [a,b,c]. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
