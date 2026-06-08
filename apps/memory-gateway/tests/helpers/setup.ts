import "dotenv/config";
import { resolve } from "node:path";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
// Default test config (individual tests may override before importing modules that read config).
process.env.MEMORIES_CONFIG ??= resolve(__dirname, "../fixtures/config.test.yaml");
