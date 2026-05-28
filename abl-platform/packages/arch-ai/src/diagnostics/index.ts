/**
 * Diagnostic engine — barrel export.
 */

export { runDiagnostics } from './diagnostic-engine.js';
export { getRule, getRulesByCategory, getAllRules, RULE_COUNT } from './rule-registry.js';
export { getFixTemplate, getCodesWithFixes } from './fix-templates.js';
export { classifyArchitecture, detectAntiPatterns } from './pattern-analyzer.js';
export {
  ALL_VALIDATORS,
  validateHandoffReturnContract,
  validatePassFieldExistence,
  validateRoutingConflicts,
  validateCompletionReachability,
  validateToolConfig,
  validateGatherQuality,
  validateConstraintSemantics,
  validateAgentIdentity,
  validateAgentNaming,
  validateDelegateContracts,
  validateGuardrailConfig,
} from './semantic-validators.js';

export { validateFlowSemantics } from './flow-validators.js';
export { validateMemorySemantics } from './memory-validators.js';
export { validateBehaviorProfiles } from './behavior-profile-validators.js';

export type {
  DiagnosticReport,
  DiagnosticSection,
  DiagnosticOptions,
  Finding,
  FixSuggestion,
  DiagnosticSeverity,
  DiagnosticCategory,
  ArchitecturePattern,
  AntiPattern,
  ValidatorContext,
  ValidatorFn,
  RuleEntry,
} from './types.js';
