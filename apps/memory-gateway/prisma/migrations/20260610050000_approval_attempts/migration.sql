-- Brute-force protection for the MCP approval gate: count failed approval-code
-- attempts per proposal; after a small threshold the MCP approve path locks and
-- approval must happen via the authenticated CLI/REST surface.
ALTER TABLE "proposals" ADD COLUMN "approval_attempts" INTEGER NOT NULL DEFAULT 0;
