/**
 * Per-slot validators — pure functions run after JSON-schema validation
 * (Ring 1) to catch domain-rule violations (Ring 2).
 *
 * Each returns `{ ok: true }` on success or `{ ok: false, error }` on
 * failure. The error string is fed back to the LLM during re-prompting.
 */

export type ValidationResult = { ok: true } | { ok: false; error: string };

const ok = (): ValidationResult => ({ ok: true });
const fail = (error: string): ValidationResult => ({ ok: false, error });

// ─── GOAL ──────────────────────────────────────────────────────────────────

export function validateGoal(value: string): ValidationResult {
  if (value.length < 20) return fail('GOAL must be at least 20 characters.');
  if (value.length > 500) return fail('GOAL must be at most 500 characters.');
  return ok();
}

// ─── PERSONA ───────────────────────────────────────────────────────────────

export function validatePersona(value: string): ValidationResult {
  if (value.length < 100) return fail('PERSONA must be at least 100 characters.');
  if (value.length > 2000) return fail('PERSONA must be at most 2000 characters.');
  return ok();
}

// ─── HANDOFF.WHEN ──────────────────────────────────────────────────────────

export function validateHandoffWhen(value: string): ValidationResult {
  const trimmed = value.trim();
  if (value.includes('{{') || value.includes('}}')) {
    return fail('HANDOFF WHEN must not contain template interpolation (no {{ or }}).');
  }
  if (trimmed === 'true') {
    return fail(
      'HANDOFF WHEN value "true" is reserved for the catch-all (code-owned). Use a descriptive user-intent condition.',
    );
  }
  if (trimmed === '' || trimmed === '""') return fail('HANDOFF WHEN cannot be empty.');
  if (value.length < 10) return fail('HANDOFF WHEN must be at least 10 characters.');
  if (value.length > 200) return fail('HANDOFF WHEN must be at most 200 characters.');
  return ok();
}

// ─── GATHER ask ────────────────────────────────────────────────────────────

export function validateGatherAsk(value: string): ValidationResult {
  const normalized = value.trim().toLowerCase();
  if (value.includes('{{') || value.includes('}}')) {
    return fail('GATHER ask must be a real domain question, not a template placeholder.');
  }
  if (
    /^(can you )?(provide|share|enter|give)( the)? (details|info|information)\??$/.test(normalized)
  ) {
    return fail('GATHER ask is too generic. Ask for the specific field in domain language.');
  }
  if (value.length < 20) return fail('GATHER ask must be at least 20 characters.');
  if (value.length > 300) return fail('GATHER ask must be at most 300 characters.');
  if (!value.includes('?')) return fail('GATHER ask must end with a "?" — phrase as a question.');
  return ok();
}

// ─── COMPLETE when ─────────────────────────────────────────────────────────

const WHEN_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'and', 'or', 'not', 'null', 'true', 'false']);

export function validateCompleteWhen(
  value: string,
  declaredGatherFields: ReadonlySet<string>,
): ValidationResult {
  if (value.length < 10) return fail('COMPLETE WHEN must be at least 10 characters.');
  if (value.length > 200) return fail('COMPLETE WHEN must be at most 200 characters.');

  const identifierRegex = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  const seen = new Set<string>();
  const undeclared: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = identifierRegex.exec(value)) !== null) {
    const id = match[0];
    if (WHEN_KEYWORDS.has(id)) continue;
    if (declaredGatherFields.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    undeclared.push(id);
  }

  if (undeclared.length > 0) {
    const declared = [...declaredGatherFields].join(', ') || '(none)';
    return fail(
      `COMPLETE WHEN references undeclared identifier(s): ${undeclared.join(', ')}. Declared GATHER fields: ${declared}.`,
    );
  }

  return ok();
}

// ─── COMPLETE respond ──────────────────────────────────────────────────────

export function validateCompleteRespond(value: string): ValidationResult {
  if (value.length > 300) return fail('COMPLETE RESPOND must be at most 300 characters.');
  return ok();
}
