import "dotenv/config";
import { execSync } from "node:child_process";

export default function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see apps/memory-gateway/.env)");
  // `pnpm exec` resolves the workspace-local prisma binary regardless of how vitest was launched.
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
