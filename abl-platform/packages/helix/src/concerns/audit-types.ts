/**
 * Shared types for the concerns audit runner. Separated from `audit.ts` so
 * detector modules can import the finding shape without circular deps.
 */

import type {
  ConcernDetectorKind,
  ConcernEnforcement,
  ConcernLoadError,
  ConcernSeverity,
  RubricConcernRef,
} from './types.js';

export interface DetectorFinding {
  readonly concernId: string;
  readonly concernTitle: string;
  readonly enforcement: ConcernEnforcement;
  readonly rubricConcern?: RubricConcernRef;
  readonly detectorId: string;
  readonly detectorKind: ConcernDetectorKind;
  readonly severity: ConcernSeverity;
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly message: string;
  readonly fixHint?: string;
  readonly matchedText?: string;
}

export interface DetectorSkip {
  readonly concernId: string;
  readonly detectorId: string;
  readonly kind: ConcernDetectorKind;
  readonly reason: string;
}

export interface AuditSummary {
  readonly concernsTotal: number;
  readonly concernsScanned: number;
  readonly detectorsRun: number;
  readonly detectorsSkipped: number;
  readonly findings: number;
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly byEnforcement: Record<ConcernEnforcement, number>;
  readonly bySeverity: Record<ConcernSeverity, number>;
  readonly byConcern: Record<string, number>;
  readonly filesScanned: number;
  readonly durationMs: number;
}

export interface AuditResult {
  readonly findings: readonly DetectorFinding[];
  readonly skipped: readonly DetectorSkip[];
  readonly summary: AuditSummary;
  readonly loadErrors: readonly ConcernLoadError[];
  readonly findingsPath?: string;
  readonly summaryPath?: string;
}

export interface AuditOptions {
  /** Repo root. Defaults to process.cwd(). */
  readonly repoRoot?: string;
  /** Concerns root dir. Defaults to `<repoRoot>/.helix/concerns`. */
  readonly concernsDir?: string;
  /** Output dir for findings JSONL + summary JSON. Defaults to `<repoRoot>/docs/sdlc-logs/concerns-audit`. */
  readonly outputDir?: string;
  /** Restrict to specific concern ids. */
  readonly filterConcernIds?: readonly string[];
  /** Restrict to specific tiers. */
  readonly filterTiers?: readonly ConcernEnforcement[];
  /** Skip writing files; return results only. Defaults to true (write). */
  readonly write?: boolean;
}
