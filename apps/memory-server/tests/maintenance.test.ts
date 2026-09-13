import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { analyzeNotes, renderOverview } from "../src/maintenance.js";
import type { Note } from "../src/vault.js";

function note(path: string, values: Partial<Note> = {}): Note {
  const content = values.content ?? `# ${path}\n`;
  return {
    path,
    title: path.split("/").at(-1)!.replace(/\.md$/, ""),
    content,
    hash: createHash("sha256").update(content).digest("hex"),
    modifiedAt: 1_000,
    tags: [],
    aliases: [],
    links: [],
    ...values,
  };
}

test("tracks additions, deleted files, and frontmatter-only edits using full hashes", () => {
  const unchanged = note("A.md");
  const before = note("B.md", { content: "---\ntags: [old]\n---\nBody stays the same.\n" });
  const edited = note("B.md", { content: "---\ntags: [new]\n---\nBody stays the same.\n" });
  const added = note("C.md");
  const report = analyzeNotes([added, edited, unchanged], {
    "A.md": unchanged.hash,
    "B.md": before.hash,
    "Removed.md": "previous-hash",
  });

  assert.deepEqual(report.changed, ["B.md", "C.md"]);
  assert.deepEqual(report.deleted, ["Removed.md"]);
  assert.deepEqual(report.hashes, { "A.md": unchanged.hash, "B.md": edited.hash, "C.md": added.hash });
  assert.deepEqual(analyzeNotes([unchanged, edited, added], report.hashes).changed, []);
});

test("flags exact duplicates without grouping similar text or changing notes", () => {
  const notes = [
    note("Copy.md", { content: "# Same\n\nA fact.\n" }),
    note("Original.md", { content: "# Same\n\nA fact.\n" }),
    note("Different metadata.md", { content: "---\naliases: [same]\n---\n# Same\n\nA fact.\n" }),
    note("Different spacing.md", { content: "# Same\nA fact.\n" }),
  ];
  const snapshot = structuredClone(notes);

  assert.deepEqual(analyzeNotes(notes).duplicates, [["Copy.md", "Original.md"]]);
  assert.deepEqual(notes, snapshot);
});

test("resolves vault paths, aliases and encoded paths without validating headings", () => {
  const notes = [
    note("Index.md", { links: ["Projects/Plan#Missing heading", "Space%20Note.md", "Reference", "#Local heading"] }),
    note("Projects/Plan.md"),
    note("Space Note.md"),
    note("Sources/Article.md", { aliases: ["Reference"] }),
  ];
  const report = analyzeNotes(notes);

  assert.deepEqual(report.brokenLinks, []);
  assert.deepEqual(report.ambiguousLinks, []);
  assert.deepEqual(report.orphans, ["Index.md"]);
});

test("resolves relative links and prefers a neighboring file to distant namesakes", () => {
  const notes = [
    note("Work/Index.md", { links: ["../Shared/Goal.md#Outcome", "./Local", "Plan", "/Global.md"] }),
    note("Shared/Goal.md"),
    note("Work/Local.md"),
    note("Work/Plan.md"),
    note("Other/Plan.md"),
    note("Global.md"),
  ];
  const report = analyzeNotes(notes);

  assert.deepEqual(report.brokenLinks, []);
  assert.deepEqual(report.ambiguousLinks, []);
  assert.deepEqual(report.orphans, ["Other/Plan.md", "Work/Index.md"]);
});

test("reports same-basename and alias ambiguity instead of choosing the first note", () => {
  const notes = [
    note("Inbox/Index.md", { links: ["Plan", "Roadmap"] }),
    note("B/Plan.md", { aliases: ["Roadmap"] }),
    note("A/Plan.md", { aliases: ["Roadmap"] }),
  ];
  const report = analyzeNotes(notes);

  assert.deepEqual(report.brokenLinks, []);
  assert.deepEqual(report.ambiguousLinks, [
    { source: "Inbox/Index.md", target: "Plan", candidates: ["A/Plan.md", "B/Plan.md"] },
    { source: "Inbox/Index.md", target: "Roadmap", candidates: ["A/Plan.md", "B/Plan.md"] },
  ]);
});

test("reports missing local notes once and ignores URLs, attachments and local anchors", () => {
  const report = analyzeNotes([
    note("Index.md", {
      links: ["Missing.md#Section", "Missing.md#Other", "https://example.com/a", "mailto:me@example.com", "//example.com/a", "image.png", "#Heading", "#^block"],
    }),
  ]);

  assert.deepEqual(report.brokenLinks, [{ source: "Index.md", target: "Missing.md" }]);
  assert.deepEqual(report.orphans, ["Index.md"]);
});

test("does not reinterpret an explicit missing relative path as a different vault note", () => {
  const report = analyzeNotes([
    note("Folder/Index.md", { links: ["./Absent", "../../Outside"] }),
    note("Elsewhere/Absent.md"),
    note("Outside.md"),
  ]);

  assert.deepEqual(report.brokenLinks, [
    { source: "Folder/Index.md", target: "../../Outside" },
    { source: "Folder/Index.md", target: "./Absent" },
  ]);
});

test("produces the same report and overview regardless of discovery order", () => {
  const notes = [
    note("Z.md", { links: ["Unknown", "A"] }),
    note("A.md", { aliases: ["First"] }),
    note("Copy.md", { content: "# A.md\n" }),
  ];
  const first = analyzeNotes(notes);
  const second = analyzeNotes([...notes].reverse().map(n => ({ ...n, links: [...n.links].reverse() })));

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderOverview(notes, first), renderOverview([...notes].reverse(), second));
});

test("overview navigates by title and path, prioritizes recent changes, and excludes bodies", () => {
  const notes = [
    note("Old.md", { title: "Old topic", modifiedAt: 100 }),
    note("New note.md", { title: "New [topic]", modifiedAt: 2_000, content: "DO_NOT_COPY_THIS_PRIVATE_BODY" }),
  ];
  const overview = renderOverview(notes, analyzeNotes(notes));

  assert.ok(overview.includes("New%20note.md"));
  assert.ok(overview.includes("New \\[topic\\]"));
  assert.ok(overview.indexOf("New%20note.md") < overview.indexOf("Old.md"));
  assert.ok(!overview.includes("DO_NOT_COPY_THIS_PRIVATE_BODY"));
  assert.ok(!overview.includes(notes[0]!.hash));
});

test("empty and large vault overviews stay bounded and contain no invalid values", () => {
  const emptyReport = analyzeNotes([]);
  assert.deepEqual(emptyReport, { hashes: {}, changed: [], deleted: [], duplicates: [], brokenLinks: [], ambiguousLinks: [], orphans: [] });
  const empty = renderOverview([], emptyReport);
  assert.ok(empty.includes("0 notes"));
  assert.ok(!/undefined|NaN|Invalid Date/.test(empty));

  const notes = Array.from({ length: 250 }, (_, i) => note(`Note ${i.toString().padStart(3, "0")}.md`));
  const overview = renderOverview(notes, analyzeNotes(notes));
  assert.ok(overview.includes("250 notes"));
  assert.ok(overview.length < 12_000);
  assert.ok(overview.includes("more"));
});
