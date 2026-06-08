import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

export interface AuditEvent {
  actor: string;
  client: string;
  action: string;
  namespace: string;
  sensitivityRequested?: string | null;
  inputs: unknown;
  returnedDocumentIds?: string[];
  approved: boolean;
}

export async function writeAudit(e: AuditEvent): Promise<void> {
  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      actor: e.actor,
      client: e.client,
      action: e.action,
      namespace: e.namespace,
      sensitivityRequested: e.sensitivityRequested ?? null,
      inputsHash: createHash("sha256").update(JSON.stringify(e.inputs)).digest("hex"),
      returnedDocumentIds: e.returnedDocumentIds ?? [],
      approved: e.approved,
    },
  });
}

export interface TraceEvent {
  actor: string;
  query: string;
  namespaceFilter: string[];
  selectedChunkIds: string[];
  selectedDocumentIds: string[];
  rankingDebug?: unknown;
}

export async function writeTrace(t: TraceEvent): Promise<string> {
  const id = randomUUID();
  await prisma.retrievalTrace.create({
    data: {
      id,
      actor: t.actor,
      query: t.query,
      namespaceFilter: t.namespaceFilter,
      selectedChunkIds: t.selectedChunkIds,
      selectedDocumentIds: t.selectedDocumentIds,
      rankingDebug: (t.rankingDebug ?? {}) as Prisma.InputJsonValue,
    },
  });
  return id;
}
