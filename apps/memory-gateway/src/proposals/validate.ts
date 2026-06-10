/**
 * Pure validation module for proposals.
 * validateProposal takes the proposal input + environment and returns a ValidationResult.
 * No I/O; all side-effects belong in callers.
 */

export interface ValidationFlag {
  code: string;
  message: string;
}

export type AutoPolicy =
  | "quick_approve_eligible"
  | "normal_review"
  | "needs_more_evidence"
  | "human_review_required";

export interface ValidationResult {
  flags: ValidationFlag[];
  score: number;
  autoPolicy: AutoPolicy;
  blocked: boolean;
}

// -------------------------------------------------------------------------
// Secret detector
// -------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  // password[:=] <value>; valid op:// references are stripped before scanning
  /password\s*[:=]\s*\S+/i,
  /Bearer [A-Za-z0-9._-]{20,}/,
  /(secret|token|key)\s*[:=]\s*[A-Fa-f0-9]{40,}/i,
  /(secret|token|key)\s*[:=]\s*[A-Za-z0-9+/=]{40,}/i,
];

/**
 * Returns a list of matched secret patterns found in `text`.
 * Explicitly ignores `secret_ref: op://…` 1Password-style references.
 */
export function detectSecrets(text: string): string[] {
  // Strip secret_ref: op://… patterns before scanning so they are never flagged.
  const sanitized = text.replace(/secret_ref:\s*op:\/\/[^\s]*/gi, "");

  const matches: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(sanitized)) {
      matches.push(pattern.source);
    }
  }
  return matches;
}

// -------------------------------------------------------------------------
// Known kinds (for scoring)
// -------------------------------------------------------------------------

const KNOWN_KINDS = new Set([
  "note",
  "finding",
  "decision",
  "runbook",
  "project-context",
  "reading-note",
  "brain-gym-memo",
  "summary",
  "insight",
]);

// -------------------------------------------------------------------------
// Sensitivities with risk score for scoring rubric
// -------------------------------------------------------------------------

const SENSITIVITY_RISK_SCORE: Record<string, number> = {
  public: 2,
  internal: 2,
  private: 1,
  confidential: 0,
  "client-confidential": 0,
  "secret-adjacent": 0,
};

// -------------------------------------------------------------------------
// Normalize title for duplicate detection
// -------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// -------------------------------------------------------------------------
// Main validation function (pure)
// -------------------------------------------------------------------------

export function validateProposal(
  input: {
    namespace: string;
    sensitivity: string;
    title: string;
    content: string;
    source_refs: string[];
    kind: string;
  },
  env: {
    allowedNamespaces: string[];
    allowedSensitivities: string[];
    existingTitles: string[];
  },
): ValidationResult {
  const flags: ValidationFlag[] = [];
  let blocked = false;

  // 1. Secret detector
  const secretMatches = detectSecrets(input.content + "\n" + input.title);
  if (secretMatches.length > 0) {
    flags.push({
      code: "secret_detected",
      message: `Potential secret detected (${secretMatches.length} pattern(s) matched). Review and remove secrets before proposing.`,
    });
    blocked = true;
  }

  // 2. Namespace checker
  const namespaceAllowed = env.allowedNamespaces.includes(input.namespace);
  if (!namespaceAllowed) {
    flags.push({
      code: "namespace_invalid",
      message: `Namespace "${input.namespace}" is not in the allowed list: ${env.allowedNamespaces.join(", ")}.`,
    });
    blocked = true;
  }

  // 3. Sensitivity checker
  const sensitivityAllowed = env.allowedSensitivities.includes(input.sensitivity);
  if (!sensitivityAllowed) {
    flags.push({
      code: "sensitivity_invalid",
      message: `Sensitivity "${input.sensitivity}" is not in the allowed list: ${env.allowedSensitivities.join(", ")}.`,
    });
    blocked = true;
  }

  // 4. Duplicate detector
  const normalizedInput = normalizeTitle(input.title);
  const duplicateMatch = env.existingTitles.find(
    (t) => normalizeTitle(t) === normalizedInput,
  );
  if (duplicateMatch) {
    flags.push({
      code: "duplicate_candidate",
      message: `Title matches existing entry: "${duplicateMatch}". Review for duplication.`,
    });

    // 5. Contradiction candidate (decision/finding kinds)
    const isContradictableKind = input.kind === "decision" || input.kind === "finding";
    if (isContradictableKind) {
      flags.push({
        code: "contradiction_candidate",
        message: `A ${input.kind} with this title already exists: "${duplicateMatch}". This may contradict or supersede it — review carefully.`,
      });
    }
  }

  // 6. Missing source check
  if (input.source_refs.length === 0) {
    flags.push({
      code: "missing_source",
      message: "No source references provided. Add source_refs to strengthen credibility.",
    });
  }

  // -----------------------------------------------------------------------
  // Scoring rubric (0–2 each, max 12)
  // -----------------------------------------------------------------------

  // Source quality: 2 if ≥1 source_ref, 0 if none
  const scoreSource = input.source_refs.length >= 1 ? 2 : 0;

  // Claim clarity: 2 if content ≥ 80 chars and title non-empty
  const scoreClarity = input.content.length >= 80 && input.title.trim().length > 0 ? 2 : 0;

  // Scope correctness: 2 if namespace allowed
  const scoreScopeCorrect = namespaceAllowed ? 2 : 0;

  // Sensitivity correctness: 2 if sensitivity allowed
  const scoreSensitivityCorrect = sensitivityAllowed ? 2 : 0;

  // Actionability: 2 if kind in known kinds list
  const scoreActionability = KNOWN_KINDS.has(input.kind) ? 2 : 0;

  // Risk-if-wrong inverse: based on sensitivity
  const scoreRisk = SENSITIVITY_RISK_SCORE[input.sensitivity] ?? 0;

  const score =
    scoreSource +
    scoreClarity +
    scoreScopeCorrect +
    scoreSensitivityCorrect +
    scoreActionability +
    scoreRisk;

  // -----------------------------------------------------------------------
  // Auto-policy
  // -----------------------------------------------------------------------
  let autoPolicy: AutoPolicy;

  if (blocked) {
    // Blocked proposals get a placeholder; they'll be rejected
    autoPolicy = "needs_more_evidence";
  } else if (
    input.sensitivity === "client-confidential" ||
    input.sensitivity === "secret-adjacent"
  ) {
    autoPolicy = "human_review_required";
  } else if (score >= 10) {
    autoPolicy = "quick_approve_eligible";
  } else if (score >= 7) {
    autoPolicy = "normal_review";
  } else {
    autoPolicy = "needs_more_evidence";
  }

  return { flags, score, autoPolicy, blocked };
}
