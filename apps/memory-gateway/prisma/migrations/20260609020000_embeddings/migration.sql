-- Semantic search: store a 768-dim embedding per chunk (pgvector) so retrieval can
-- match by meaning, not only by shared keywords. Embeddings are best-effort and
-- nullable; a chunk with a null embedding simply isn't a vector-search candidate.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "chunks" ADD COLUMN "embedding" vector(768);

-- HNSW (cosine) needs no training and works on an empty/small table.
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
