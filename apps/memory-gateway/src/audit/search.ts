// This function is intentionally NOT audited itself — doing so would cause recursion noise.
import { prisma } from "../db/client";

export interface AuditSearchFilter {
  action?: string;
  client?: string;
  approved?: boolean;
  limit?: number;
}

export interface AuditRow {
  id: string;
  actor: string;
  client: string;
  action: string;
  namespace: string;
  approved: boolean | null;
  createdAt: Date;
}

export async function searchAudit(filter: AuditSearchFilter = {}): Promise<AuditRow[]> {
  const { action, client, approved, limit } = filter;
  const take = Math.min(limit ?? 50, 500);

  const rows = await prisma.auditLog.findMany({
    where: {
      ...(action !== undefined ? { action } : {}),
      ...(client !== undefined ? { client } : {}),
      ...(approved !== undefined ? { approved } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      actor: true,
      client: true,
      action: true,
      namespace: true,
      approved: true,
      createdAt: true,
    },
  });

  return rows;
}
