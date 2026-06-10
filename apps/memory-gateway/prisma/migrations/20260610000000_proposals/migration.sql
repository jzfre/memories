CREATE TABLE "knowledge_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source_ref" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "knowledge_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "proposal_type" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "proposed_content" TEXT NOT NULL,
    "target_document_id" TEXT,
    "source_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "confidence" TEXT NOT NULL DEFAULT 'unknown',
    "review_state" TEXT NOT NULL DEFAULT 'pending_review',
    "reviewer_notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ,
    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "proposals_review_state_idx" ON "proposals"("review_state");
CREATE INDEX "proposals_namespace_idx" ON "proposals"("namespace");
