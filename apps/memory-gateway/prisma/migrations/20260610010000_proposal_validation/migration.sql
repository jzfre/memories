ALTER TABLE "proposals"
  ADD COLUMN "validation_flags" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "score" INTEGER,
  ADD COLUMN "auto_policy" TEXT;
