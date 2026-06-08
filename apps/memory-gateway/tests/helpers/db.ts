import { prisma } from "../../src/db/client";

export { prisma };

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "chunks","documents","audit_log","retrieval_traces" RESTART IDENTITY CASCADE',
  );
}
