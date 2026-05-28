export type {
  Concern,
  ConcernAcceptance,
  ConcernDetector,
  ConcernDetectorBase,
  ConcernDetectorKind,
  ConcernEnforcement,
  ConcernLoadError,
  ConcernLoadResult,
  ConcernReferences,
  ConcernScope,
  ConcernSeverity,
  ConcernStageHook,
  ConcernStageType,
  ConcernsRegistry,
  GrepDetector,
  AstDetector,
  SymbolRefDetector,
  RouteDetector,
  SchemaDetector,
  ImpactedTestDetector,
  ScriptDetector,
  ModelReviewDetector,
  ModelReviewOutputSchema,
} from './types.js';

export { loadConcernsRegistry } from './loader.js';
export type { ConcernsLoaderOptions } from './loader.js';

export {
  concernsApplyingTo,
  concernsForFile,
  globToRegExp,
  normalizePath,
  scopeMatches,
} from './applicability.js';

export { runConcernsAudit } from './audit.js';
export type {
  AuditOptions,
  AuditResult,
  AuditSummary,
  DetectorFinding,
  DetectorSkip,
} from './audit-types.js';
export { walkRepoFiles, MAX_WALK_FILES, defaultIgnoreDirs } from './file-walker.js';
export type { WalkOptions } from './file-walker.js';
export { runGrepDetector } from './detectors/grep.js';
