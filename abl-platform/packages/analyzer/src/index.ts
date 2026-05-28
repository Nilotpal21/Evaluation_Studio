/**
 * @abl/analyzer
 *
 * Static analysis for Agent ABL - conflict detection, coverage analysis, security rules
 */

// Export types
export type {
  Severity,
  SourceLocation,
  AnalysisResult,
  AnalysisRule,
  AnalysisContext,
  ProjectContext,
  ProjectConfig,
  AnalysisSummary,
  AnalysisReport,
} from './types.js';

// Export analyzer
export { DSLAnalyzer, createAnalyzer, analyze } from './analyzer.js';
export type { AnalyzerConfig } from './analyzer.js';

// Export rules
export {
  allRules,
  getRulesByCategory,
  getRuleById,
  conflictRules,
  coverageRules,
  securityRules,
} from './rules/index.js';

// Export individual rules for customization
export {
  contradictoryConditions,
  policyContradictions,
  unreachableRules,
  missingDefaultRouting,
  scheduleConstraintConflicts,
  DEFAULT_SCHEDULE_CONFIG,
} from './rules/conflicts.js';

export type { ScheduleConstraintConfig } from './rules/conflicts.js';

export {
  unhandledIntents,
  deadSteps,
  missingErrorHandlers,
  infiniteLoopRisk,
  missingSignals,
} from './rules/coverage.js';

export { piiDetection, missingAuthGates, handoffDataProtection } from './rules/security.js';
