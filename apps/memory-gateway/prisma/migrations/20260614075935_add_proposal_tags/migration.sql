-- Add a tags array to proposals so a proposed note can carry validated tags
-- (written into the note's frontmatter on approval instead of a hard-coded []).
ALTER TABLE "proposals" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
