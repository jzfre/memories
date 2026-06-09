import "dotenv/config";
import { resolve } from "node:path";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
// Default test config (individual tests may override before importing modules that read config).
process.env.MEMORIES_CONFIG ??= resolve(__dirname, "../fixtures/config.test.yaml");
// Force embeddings OFF for the suite (apps/.env enables them). Tests stay full-text-only
// and deterministic; tests that exercise the vector path inject their own embedder.
process.env.EMBEDDINGS_ENABLED = "0";
