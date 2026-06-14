import { CONFIDENCE_VALUES, STATUS_VALUES } from "./types";

/** Canonical note kinds. Single source of truth (was duplicated in validate.ts + the skill). */
export const KIND_VALUES = [
  "note",
  "finding",
  "decision",
  "runbook",
  "project-context",
  "reading-note",
  "brain-gym-memo",
  "summary",
  "insight",
] as const;
export type Kind = (typeof KIND_VALUES)[number];

/** Kinds that require a specific body structure. */
export const STRUCTURED_KINDS = [
  "decision",
  "finding",
  "project-context",
  "runbook",
  "brain-gym-memo",
] as const;

/** Required section headings per structured kind (derived from vault-templates/). */
export const BODY_TEMPLATES: Record<string, string[]> = {
  decision: ["Claim", "Context", "Evidence", "Assumptions", "Tradeoffs", "Decision", "Consequences", "What would change this"],
  finding: ["Finding", "Evidence", "Source references", "Confidence", "Validation needed", "Risk if wrong", "Related notes"],
  "project-context": ["Summary", "Goals", "Constraints", "Key decisions", "Open questions"],
  runbook: ["Purpose", "Preconditions", "Steps", "Verification", "Rollback", "Notes"],
  "brain-gym-memo": ["Claim", "Evidence", "Assumptions", "Tradeoffs", "Next test", "What would change my mind", "Evaluation"],
};

export type IssueSeverity = "block" | "flag";
export interface NoteIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
}
export type SeverityOverrides = Record<string, IssueSeverity>;

/** Default severity per issue code. `block` => reject at proposal-time. */
export const DEFAULT_SEVERITY: Record<string, IssueSeverity> = {
  invalid_kind: "block",
  invalid_confidence: "block",
  invalid_status: "block",
  invalid_tags: "block",
  body_frontmatter_injection: "block",
  missing_required_section: "block",
  body_raw_html: "flag",
  body_malformed_wikilink: "flag",
};

function sev(code: string, overrides?: SeverityOverrides): IssueSeverity {
  return overrides?.[code] ?? DEFAULT_SEVERITY[code] ?? "flag";
}

export interface NoteFields {
  kind: string;
  confidence: string;
  status: string;
  tags: string[];
}

/** Tag rule: starts alphanumeric; lowercase letters/digits plus . _ / - ; <=50 chars. */
const TAG_RE = /^[a-z0-9][a-z0-9._/-]{0,49}$/;

export function validateNoteFields(fields: NoteFields, overrides?: SeverityOverrides): NoteIssue[] {
  const issues: NoteIssue[] = [];
  if (!(KIND_VALUES as readonly string[]).includes(fields.kind)) {
    issues.push({ code: "invalid_kind", message: `kind "${fields.kind}" is not one of: ${KIND_VALUES.join(", ")}.`, severity: sev("invalid_kind", overrides) });
  }
  if (!(CONFIDENCE_VALUES as readonly string[]).includes(fields.confidence)) {
    issues.push({ code: "invalid_confidence", message: `confidence "${fields.confidence}" is not one of: ${CONFIDENCE_VALUES.join(", ")}.`, severity: sev("invalid_confidence", overrides) });
  }
  if (!(STATUS_VALUES as readonly string[]).includes(fields.status)) {
    issues.push({ code: "invalid_status", message: `status "${fields.status}" is not one of: ${STATUS_VALUES.join(", ")}.`, severity: sev("invalid_status", overrides) });
  }
  const badTags = fields.tags.filter((t) => !TAG_RE.test(t));
  if (badTags.length > 0) {
    issues.push({ code: "invalid_tags", message: `Invalid tag(s): ${badTags.join(", ")}. Tags are lowercase, no spaces or '#', start alphanumeric, <=50 chars (use '/' for hierarchy).`, severity: sev("invalid_tags", overrides) });
  }
  return issues;
}

function headingTexts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].toLowerCase().replace(/[:?.]+$/, "").trim());
  }
  return out;
}

export function validateNoteBody(body: string, kind: string, overrides?: SeverityOverrides): NoteIssue[] {
  const issues: NoteIssue[] = [];

  // 1. Frontmatter injection — body must not begin with a --- block (gateway writes frontmatter).
  const firstLine = body.trimStart().split(/\r?\n/)[0] ?? "";
  if (/^---\s*$/.test(firstLine)) {
    issues.push({ code: "body_frontmatter_injection", message: "Body must not begin with a '---' frontmatter block.", severity: sev("body_frontmatter_injection", overrides) });
  }

  // 2. Raw HTML (Obsidian renders Markdown; avoid raw HTML).
  if (/<(script|iframe|style|object|embed|form|input|div|table|span|img)\b/i.test(body)) {
    issues.push({ code: "body_raw_html", message: "Body contains raw HTML; use Obsidian-renderable Markdown instead.", severity: sev("body_raw_html", overrides) });
  }

  // 3. Malformed / empty wikilink: unbalanced [[ ]] pairs, or an empty [[]].
  // NOTE: heuristic only — counts [[ vs ]] and does not parse Markdown code fences/spans,
  // so a stray `]]` inside code can false-positive. Severity is "flag" (never blocks).
  const opens = (body.match(/\[\[/g) ?? []).length;
  const closes = (body.match(/\]\]/g) ?? []).length;
  if (opens !== closes || /\[\[\s*\]\]/.test(body)) {
    issues.push({ code: "body_malformed_wikilink", message: "Body has a malformed or empty [[wikilink]].", severity: sev("body_malformed_wikilink", overrides) });
  }

  // 4. Required sections for structured kinds.
  const required = BODY_TEMPLATES[kind];
  if (required) {
    const present = headingTexts(body);
    const missing = required.filter(
      (sec) => !present.some((h) => h === sec.toLowerCase() || h.startsWith(sec.toLowerCase())),
    );
    if (missing.length > 0) {
      issues.push({ code: "missing_required_section", message: `${kind} note is missing required section(s): ${missing.join(", ")}.`, severity: sev("missing_required_section", overrides) });
    }
  }
  return issues;
}

export function validateNote(fields: NoteFields, body: string, overrides?: SeverityOverrides): NoteIssue[] {
  return [...validateNoteFields(fields, overrides), ...validateNoteBody(body, fields.kind, overrides)];
}

export function hasBlocking(issues: NoteIssue[]): boolean {
  return issues.some((i) => i.severity === "block");
}
