/**
 * Spec Document field map — editable path registry and session field mapping.
 *
 * V1_EDITABLE_PATHS:  the list of dot-paths that the UI/API is allowed to patch
 *                     directly on the spec document (business section only for v1).
 *
 * SPEC_TO_SESSION_FIELD_MAP:  maps spec document paths to the canonical field
 *                              names in the session Specification object, so that
 *                              edits can be mirrored back to the live session.
 */

// ─── Editable paths ───────────────────────────────────────────────────────────

/**
 * The nine business-section paths that external callers may PATCH.
 * All other paths are computed by the Arch AI pipeline and are read-only.
 *
 * This is a static constant — never mutated at runtime.
 */
export const V1_EDITABLE_PATHS: ReadonlyArray<string> = [
  'business.projectName',
  'business.objective',
  'business.channels',
  'business.language',
  'business.personas',
  'business.compliance',
  'business.slas',
  'business.notes',
  'business.completedAt',
] as const;

// ─── Session field mapping ────────────────────────────────────────────────────

/**
 * Maps a subset of spec document paths to their corresponding field names
 * in the session Specification object stored on the Arch session model.
 *
 * When a user edits these fields through the spec document API, the session
 * Specification must be updated in parallel to keep the live session in sync.
 *
 * Paths not present in this map affect only the spec document.
 */
export const SPEC_TO_SESSION_FIELD_MAP: Readonly<Record<string, string>> = {
  'business.projectName': 'projectName',
  'business.objective': 'description',
  'business.channels': 'channels',
  'business.language': 'language',
} as const;

// ─── Validation ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate that `path` is in the set of editable spec document paths.
 * Throws ValidationError if the path is not editable.
 */
export function validateEditablePath(path: string): void {
  if (!V1_EDITABLE_PATHS.includes(path)) {
    throw new ValidationError(
      `Path '${path}' is not editable. Allowed paths: ${V1_EDITABLE_PATHS.join(', ')}`,
      path,
    );
  }
}
