import { posix } from "node:path";
import type { Note } from "./vault.js";

export interface MaintenanceReport {
  hashes: Record<string, string>;
  changed: string[];
  deleted: string[];
  duplicates: string[][];
  brokenLinks: { source: string; target: string }[];
  ambiguousLinks: { source: string; target: string; candidates: string[] }[];
  /** Notes with no unambiguous incoming link from another note. */
  orphans: string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const withoutExtension = (value: string): string => value.replace(/\.md$/i, "");
const nameKey = (value: string): string => value.trim().normalize("NFC").toLowerCase();
const ATTACHMENT = /\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|docx?|xlsx?|pptx?|mp[34]|wav|ogg|mov|zip|csv|canvas)$/i;

function linkTarget(raw: string): string {
  const target = raw.trim().split(/[|#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(target).trim();
  } catch {
    return target;
  }
}

/** Analyze a snapshot only. No file writes, automatic merges, or model calls. */
export function analyzeNotes(notes: Note[], previousHashes: Record<string, string> = {}): MaintenanceReport {
  const ordered = [...notes].sort((a, b) => compare(a.path, b.path));
  const hashes = Object.fromEntries(ordered.map(note => [note.path, note.hash]));
  const paths = new Set(ordered.map(note => note.path));
  const byPath = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const byHash = new Map<string, string[]>();
  const addName = (index: Map<string, Set<string>>, name: string, path: string) => {
    const key = nameKey(name);
    if (!key) return;
    const matches = index.get(key) ?? new Set<string>();
    matches.add(path);
    index.set(key, matches);
  };

  for (const note of ordered) {
    addName(byPath, withoutExtension(note.path), note.path);
    for (const name of [withoutExtension(posix.basename(note.path)), note.title, ...note.aliases]) {
      addName(byName, name, note.path);
    }
    const identical = byHash.get(note.hash) ?? [];
    identical.push(note.path);
    byHash.set(note.hash, identical);
  }

  const pathMatches = (candidate: string): string[] => {
    const normalized = posix.normalize(candidate);
    if (normalized === ".." || normalized.startsWith("../")) return [];
    const filePath = /\.md$/i.test(normalized) ? normalized : `${normalized}.md`;
    if (paths.has(filePath)) return [filePath];
    return [...(byPath.get(nameKey(withoutExtension(normalized))) ?? [])].sort(compare);
  };

  const resolve = (source: string, target: string): string[] => {
    if (target.startsWith("/")) return pathMatches(target.slice(1));
    const relative = posix.join(posix.dirname(source), target);
    if (/^\.\.?\//.test(target)) return pathMatches(relative);
    // Qualified paths prefer the vault root; bare names prefer a neighbor.
    const candidates = target.includes("/") ? [target, relative] : [relative, target];
    for (const candidate of candidates) {
      const matches = pathMatches(candidate);
      if (matches.length) return matches;
    }
    if (target.includes("/")) return [];
    return [...(byName.get(nameKey(withoutExtension(target))) ?? [])].sort(compare);
  };

  const brokenLinks: MaintenanceReport["brokenLinks"] = [];
  const ambiguousLinks: MaintenanceReport["ambiguousLinks"] = [];
  const referenced = new Set<string>();
  for (const note of ordered) {
    const targets = [...new Set(note.links.map(linkTarget))].sort(compare);
    for (const target of targets) {
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const matches = resolve(note.path, target);
      if (matches.length === 1) {
        if (matches[0] !== note.path) referenced.add(matches[0]!);
      } else if (matches.length > 1) {
        ambiguousLinks.push({ source: note.path, target, candidates: matches });
      } else if (!ATTACHMENT.test(target)) {
        brokenLinks.push({ source: note.path, target });
      }
    }
  }

  return {
    hashes,
    changed: ordered.filter(note => previousHashes[note.path] !== note.hash).map(note => note.path),
    deleted: Object.keys(previousHashes).filter(path => !paths.has(path)).sort(compare),
    duplicates: [...byHash.values()].filter(group => group.length > 1),
    brokenLinks,
    ambiguousLinks,
    orphans: ordered.filter(note => !referenced.has(note.path)).map(note => note.path),
  };
}

function noteLink(note: Note): string {
  const title = (note.title || note.path).replace(/\s+/g, " ").slice(0, 160)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\[\]]/g, "\\$&");
  const path = note.path.split("/").map(encodeURIComponent).join("/");
  return `- [${title}](<${path}>)`;
}

/** A bounded navigation summary; source bodies and hashes stay out of context. */
export function renderOverview(notes: Note[], report: MaintenanceReport): string {
  const changed = new Set(report.changed);
  const recent = notes.filter(note => changed.has(note.path))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || compare(a.path, b.path));
  const ordered = [...notes].sort((a, b) => compare(a.path, b.path));
  const lines = [
    "# Memories overview",
    "",
    `${notes.length} notes; ${report.changed.length} changed; ${report.deleted.length} deleted since the previous scan.`,
    `${report.duplicates.length} exact duplicate groups; ${report.brokenLinks.length} broken links; ${report.ambiguousLinks.length} ambiguous links; ${report.orphans.length} notes without incoming links.`,
    "",
    "## Recently changed",
    "",
    ...recent.slice(0, 10).map(noteLink),
  ];
  if (!recent.length) lines.push("No changes since the previous scan.");
  if (recent.length > 10) lines.push(`- ${recent.length - 10} more changed notes.`);
  lines.push("", "## Notes", "", ...ordered.slice(0, 100).map(noteLink));
  if (!ordered.length) lines.push("No notes yet.");
  if (ordered.length > 100) lines.push(`- ${ordered.length - 100} more notes; search to find them.`);
  return `${lines.join("\n")}\n`;
}
