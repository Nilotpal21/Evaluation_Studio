/**
 * Cross-cutting concerns registry types.
 *
 * Concerns declare repo-specific invariants (tenant isolation, encryption,
 * session identity, UX quality, etc.) that Helix checks against during
 * audit and implementation. The framework is repo-independent; concerns
 * live in `.helix/concerns/` in each repo that uses Helix.
 */

export type ConcernEnforcement = 'blocking' | 'advisory';

export type ConcernSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Detector kinds in priority order — prefer deterministic kinds. Reach for
 * `model-review` only when the rule cannot be expressed deterministically,
 * and only when the detector declares a structured output schema (no
 * freeform prose).
 */
export type ConcernDetectorKind =
  | 'grep'
  | 'ast'
  | 'symbol-ref'
  | 'route'
  | 'schema'
  | 'impacted-test'
  | 'script'
  | 'model-review';

export type ConcernStageType =
  | 'bootstrap'
  | 'deep-scan'
  | 'oracle-analysis'
  | 'plan-generation'
  | 'manifest-compilation'
  | 'user-checkpoint'
  | 'implementation'
  | 'testing'
  | 'review'
  | 'bulk-review'
  | 'commit-checkpoint'
  | 'regression'
  | 'doc-sync'
  | 'reproduce'
  | 'root-cause'
  | 'security-audit'
  | 'ux-design-audit'
  | 'custom';

export interface ConcernScope {
  readonly globs: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ConcernReferences {
  readonly docs?: readonly string[];
  readonly tests?: readonly string[];
  readonly relatedConcerns?: readonly string[];
}

/**
 * 1–16, matching the canonical review rubric at
 * `docs/sdlc/change-review-rubric.md`. Each Helix concern should declare
 * which rubric concern it implements so reviewers, model-review detectors,
 * and post-impl sync can reconcile registry findings with rubric language.
 */
export type RubricConcernRef = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

/**
 * Narrative rubric sections mirrored from the rubric doc. Optional on a
 * concern — when present, they are fed to model-review detectors and
 * rendered in audit reports alongside deterministic findings.
 */
export interface ConcernRubricFields {
  readonly rubricConcern?: RubricConcernRef;
  readonly protects?: readonly string[];
  readonly reviewWhen?: readonly string[];
  readonly reviewQuestions?: readonly string[];
  readonly proofExpected?: readonly string[];
}

export interface ConcernDetectorBase {
  readonly id: string;
  readonly kind: ConcernDetectorKind;
  readonly severity?: ConcernSeverity;
  readonly message: string;
  readonly fixHint?: string;
}

export interface GrepDetector extends ConcernDetectorBase {
  readonly kind: 'grep';
  readonly pattern: string;
  readonly glob?: string;
  readonly multiline?: boolean;
}

export interface AstDetector extends ConcernDetectorBase {
  readonly kind: 'ast';
  readonly query: string;
  readonly assertion?: string;
}

export interface SymbolRefDetector extends ConcernDetectorBase {
  readonly kind: 'symbol-ref';
  readonly symbol: string;
  readonly assertion?: string;
}

export interface RouteDetector extends ConcernDetectorBase {
  readonly kind: 'route';
  readonly routePattern: string;
  readonly assertion?: string;
  readonly glob?: string;
}

export interface SchemaDetector extends ConcernDetectorBase {
  readonly kind: 'schema';
  readonly schemaName: string;
  readonly assertion?: string;
}

export interface ImpactedTestDetector extends ConcernDetectorBase {
  readonly kind: 'impacted-test';
  readonly assertion: string;
}

export interface ScriptDetector extends ConcernDetectorBase {
  readonly kind: 'script';
  readonly script: string;
}

/**
 * Output schema contract for a model-review detector. This is the canonical
 * structured finding shape. Model-review detectors must emit findings in
 * this form — freeform advisory prose is not permitted.
 */
export interface ModelReviewOutputSchema {
  readonly ruleId: string;
  readonly severity: string;
  readonly location: { readonly file: string; readonly line: string | number };
  readonly claim: string;
  readonly reality: string;
  readonly options: Readonly<Record<string, string>>;
}

export interface ModelReviewDetector extends ConcernDetectorBase {
  readonly kind: 'model-review';
  readonly guidanceRef: string;
  readonly outputSchema: ModelReviewOutputSchema;
}

export type ConcernDetector =
  | GrepDetector
  | AstDetector
  | SymbolRefDetector
  | RouteDetector
  | SchemaDetector
  | ImpactedTestDetector
  | ScriptDetector
  | ModelReviewDetector;

export interface ConcernStageHook {
  readonly stage: ConcernStageType;
  readonly injectChecklist?: boolean;
  readonly asReviewLens?: boolean;
}

export interface ConcernAcceptance {
  readonly when: string;
  readonly requires: string;
}

export interface Concern extends ConcernRubricFields {
  readonly id: string;
  readonly title: string;
  readonly enforcement: ConcernEnforcement;
  readonly severityDefault: ConcernSeverity;
  readonly scope: ConcernScope;
  readonly references?: ConcernReferences;
  readonly detectors: readonly ConcernDetector[];
  readonly stageHooks?: readonly ConcernStageHook[];
  readonly acceptance?: readonly ConcernAcceptance[];
  /** Absolute path to the source YAML file. Populated by the loader. */
  readonly sourcePath: string;
}

export interface ConcernsRegistry {
  readonly byId: ReadonlyMap<string, Concern>;
  readonly enforced: readonly Concern[];
  readonly advisory: readonly Concern[];
  readonly all: readonly Concern[];
}

export interface ConcernLoadError {
  readonly sourcePath: string;
  readonly message: string;
}

export interface ConcernLoadResult {
  readonly registry: ConcernsRegistry;
  readonly errors: readonly ConcernLoadError[];
}
