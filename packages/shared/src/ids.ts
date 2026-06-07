import { createHash } from "node:crypto";

export function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function documentIdFromPath(relPath: string): string {
  return relPath
    .replace(/\.md$/i, "")
    .split(/[/\\]+/)
    .filter(Boolean)
    .join(".")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

export function chunkId(documentId: string, index: number): string {
  return `${documentId}#${index}`;
}
