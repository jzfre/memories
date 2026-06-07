CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" TEXT,
    "checksum" TEXT NOT NULL,
    "frontmatter" JSONB NOT NULL DEFAULT '{}',
    "body_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "indexed_at" TIMESTAMPTZ,
    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "documents_path_key" ON "documents"("path");
CREATE INDEX "documents_namespace_idx" ON "documents"("namespace");
CREATE INDEX "documents_sensitivity_idx" ON "documents"("sensitivity");

CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "heading_path" TEXT,
    "content" TEXT NOT NULL,
    "token_count" INTEGER,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chunks_document_id_idx" ON "chunks"("document_id");
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");

ALTER TABLE "chunks"
    ADD CONSTRAINT "chunks_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sensitivity_requested" TEXT,
    "inputs_hash" TEXT,
    "returned_document_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "approved" BOOLEAN,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "retrieval_traces" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "namespace_filter" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "selected_chunk_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "selected_document_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ranking_debug" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "retrieval_traces_pkey" PRIMARY KEY ("id")
);
