import { UNTRUSTED_CONTENT_NOTE } from "@memories/shared";
import { loadConfig } from "../config/index";
import { prisma } from "../db/client";
import { resolveScope } from "../policy/index";
import { writeAudit } from "../audit/index";

export interface FetchedDocument {
  document_id: string;
  title: string;
  path: string;
  kind: string;
  namespace: string;
  sensitivity: string;
  status: string;
  confidence: string | null;
  frontmatter: unknown;
  body: string;
  safety_note: string;
}

export async function fetchDocument(
  documentId: string,
  ctx: { client: string },
): Promise<FetchedDocument | null> {
  const { actor } = loadConfig();
  const scope = resolveScope({});
  const doc = await prisma.document.findUnique({ where: { id: documentId } });

  const allowed =
    !!doc &&
    scope.namespaces.includes(doc.namespace) &&
    scope.sensitivities.includes(doc.sensitivity) &&
    doc.status !== "archived";

  await writeAudit({
    actor,
    client: ctx.client,
    action: "memory.fetch",
    namespace: doc?.namespace ?? "n/a",
    sensitivityRequested: doc?.sensitivity ?? null,
    inputs: { document_id: documentId },
    returnedDocumentIds: allowed ? [documentId] : [],
    approved: allowed,
  });

  if (!allowed || !doc) return null;

  return {
    document_id: doc.id,
    title: doc.title,
    path: doc.path,
    kind: doc.kind,
    namespace: doc.namespace,
    sensitivity: doc.sensitivity,
    status: doc.status,
    confidence: doc.confidence,
    frontmatter: doc.frontmatter,
    body: doc.bodyText,
    safety_note: UNTRUSTED_CONTENT_NOTE,
  };
}
