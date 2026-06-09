import { basename } from "node:path";
import matter from "gray-matter";
import type { NormalizedFrontmatter } from "./types";

export interface ParseDefaults {
  namespace: string;
  sensitivity: string;
}

export interface ParseResult {
  frontmatter: NormalizedFrontmatter;
  title: string;
  body: string;
  warnings: string[];
}

function titleFromBody(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

export function parseNote(raw: string, relPath: string, defaults: ParseDefaults): ParseResult {
  const warnings: string[] = [];
  let data: Record<string, unknown> = {};
  let body = raw;

  try {
    // Pass an explicit options object to bypass gray-matter's module-level cache,
    // which would return a stale pre-parse entry if a previous call threw during parseMatter.
    const parsed = matter(raw, {});
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content ?? "";
  } catch (e) {
    warnings.push(`frontmatter parse error: ${(e as Error).message}`);
    body = raw;
  }

  const str = (k: string): string | undefined => {
    const v = data[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };

  let namespace = str("namespace");
  if (!namespace) {
    namespace = defaults.namespace;
    warnings.push("missing 'namespace'; applied default");
  }

  let sensitivity = str("sensitivity");
  if (!sensitivity) {
    sensitivity = defaults.sensitivity;
    warnings.push("missing 'sensitivity'; applied default");
  }

  const tags = Array.isArray(data.tags)
    ? (data.tags.filter((t) => typeof t === "string") as string[])
    : [];

  const title =
    str("title") ?? titleFromBody(body) ?? basename(relPath).replace(/\.md$/i, "");

  const frontmatter: NormalizedFrontmatter = {
    id: str("id"),
    kind: str("kind") ?? "note",
    namespace,
    sensitivity,
    status: str("status") ?? "active",
    confidence: str("confidence") ?? "unknown",
    tags,
    raw: data,
  };

  return { frontmatter, title, body, warnings };
}
