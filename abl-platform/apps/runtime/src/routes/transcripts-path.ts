import * as path from 'node:path';

export const TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidTranscriptIdError extends Error {
  readonly code = 'INVALID_TRANSCRIPT_ID';
  constructor() {
    super('Transcript id contains invalid characters or escapes the transcripts directory');
    this.name = 'InvalidTranscriptIdError';
  }
}

/**
 * Validate a transcript id and resolve it to an absolute file path inside
 * `baseDir`. Throws {@link InvalidTranscriptIdError} for any id that fails
 * the character-class check or whose resolved path escapes `baseDir`.
 *
 * The character-class check rejects path separators, dots, and percent-encoded
 * sequences before any filesystem call; the post-resolve boundary check is a
 * second line of defence against future regex relaxation.
 */
export function resolveTranscriptPath(id: string, baseDir: string): string {
  if (typeof id !== 'string' || id.length === 0 || !TRANSCRIPT_ID_PATTERN.test(id)) {
    throw new InvalidTranscriptIdError();
  }

  const baseResolved = path.resolve(baseDir);
  const candidate = path.resolve(baseResolved, `${id}.json`);
  if (candidate !== baseResolved && !candidate.startsWith(baseResolved + path.sep)) {
    throw new InvalidTranscriptIdError();
  }
  return candidate;
}
