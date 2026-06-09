ALTER TABLE "documents"
  ADD COLUMN "parse_status" TEXT NOT NULL DEFAULT 'parsed',
  ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'valid',
  ADD COLUMN "validation_issues" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "embedding_status" TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN "embedded_at" TIMESTAMPTZ,
  ADD COLUMN "last_error" TEXT;

-- Backfill embedding_status='current' for docs whose chunks are all embedded (incl. 0-chunk docs).
UPDATE "documents" d
SET "embedding_status" = 'current', "embedded_at" = now()
WHERE NOT EXISTS (
  SELECT 1 FROM "chunks" c WHERE c.document_id = d.id AND c.embedding IS NULL
);
