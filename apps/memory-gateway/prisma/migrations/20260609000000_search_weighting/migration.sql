-- Search quality: index document title + heading path alongside body content,
-- using weighted lexemes (title = A, heading = B, body = C) so that a query word
-- appearing only in a note's title/heading still matches (and ranks highly).
--
-- The original tsv was GENERATED over `content` alone, so title-only words
-- (e.g. "decision") were unsearchable. We denormalize the owning document's
-- title onto each chunk so the generated column can reference it in-row.

ALTER TABLE "chunks" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- Backfill existing chunks from their owning document before the generated
-- tsv column is (re)created, so historical rows index their titles too.
UPDATE "chunks" c
SET "title" = d."title"
FROM "documents" d
WHERE d."id" = c."document_id";

-- Replace the body-only tsv with a weighted title+heading+body tsv.
DROP INDEX IF EXISTS "chunks_tsv_idx";
ALTER TABLE "chunks" DROP COLUMN "tsv";
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("heading_path", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("content", '')), 'C')
) STORED;

CREATE INDEX "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");
