-- Index document metadata (namespace, kind, tags) into the searchable tsvector so a
-- query word that only appears in a note's namespace/folder/tags still matches. This
-- is what lets "brain gym" reach a note in the `brain-gym` namespace whose title is the
-- single token "BrainGym" and whose body never says "brain" or "gym".

ALTER TABLE "chunks" ADD COLUMN "meta" TEXT NOT NULL DEFAULT '';

-- Backfill from the owning document (namespace + kind). Tags live in frontmatter JSON
-- and are filled on the next scan; a re-index repopulates meta fully.
UPDATE "chunks" c
SET "meta" = coalesce(d."namespace", '') || ' ' || coalesce(d."kind", '')
FROM "documents" d
WHERE d."id" = c."document_id";

DROP INDEX IF EXISTS "chunks_tsv_idx";
ALTER TABLE "chunks" DROP COLUMN "tsv";
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("meta", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("heading_path", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("content", '')), 'C')
) STORED;

CREATE INDEX "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");
