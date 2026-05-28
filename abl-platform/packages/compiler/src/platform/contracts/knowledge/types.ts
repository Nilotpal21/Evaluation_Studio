/**
 * Knowledge Catalog — compiler-owned source of truth for Arch AI's knowledge of
 * ABL constructs, valid combinations, CEL grammar, validation codes, and runtime
 * feasibility checks.
 *
 * The generated catalog merges live compiler/runtime sources with small
 * hand-authored seed registries where the compiler does not yet expose a
 * structured source API.
 */

export type AgentKind = 'agent' | 'supervisor' | 'behavior_profile';

export type CelContext =
  | 'handoff_when'
  | 'delegate_when'
  | 'flow_when'
  | 'complete_when'
  | 'constraint_condition'
  | 'guardrail_when'
  | 'routing_rule_when'
  | 'recall_condition'
  | 'digression_condition';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticCategory =
  | 'handoff'
  | 'delegation'
  | 'completion'
  | 'flow'
  | 'constraint'
  | 'guardrail'
  | 'tool'
  | 'gather'
  | 'memory'
  | 'execution'
  | 'routing'
  | 'behavior-profile'
  | 'template'
  | 'pattern'
  | 'naming'
  | 'other';

export interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  enumValues?: string[];
  description?: string;
}

export interface ConstructSpec {
  name: string;
  fields: FieldSpec[];
  examples: string[];
  validInContexts: AgentKind[];
  source: { file: string; lines: [number, number] };
}

export interface CelFunctionSpec {
  name: string;
  signature: string;
  category: string;
  description?: string;
}

export interface LifecycleEventSpec {
  pattern: string;
  appliesTo: ('on_start' | 'on_error' | 'recall')[];
  legacyAlias?: string;
}

export type CombinationRelation = 'may-coexist' | 'mutually-exclusive' | 'requires' | 'depends-on';

export type CoverageLevel = 'enforced' | 'advisory';

export interface CombinationRule {
  ruleId: string;
  constructA: string;
  constructB: string;
  relation: CombinationRelation;
  validatorCode?: string;
  coverage: CoverageLevel;
  rationale: string;
}

export interface MandatoryRule {
  ruleId: string;
  description: string;
  appliesToConstruct: string;
  coverage: CoverageLevel;
  rationale: string;
}

export interface FeasibilityCheckSpec {
  name: string;
  description: string;
  category: 'model' | 'memory' | 'channel' | 'tool' | 'flow';
  reusesAnalyzer?: string;
}

export interface ValidationCodeMeta {
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  meaning: string;
  remediation: string;
}

export interface KnowledgeCatalog {
  version: string;
  generatedAt: string;
  constructs: ConstructSpec[];
  validationCodes: Record<string, ValidationCodeMeta>;
  cel: {
    functions: CelFunctionSpec[];
    globalVariables: string[];
    perContextAllowlist: Record<CelContext, string[]>;
  };
  lifecycleEvents: LifecycleEventSpec[];
  validCombinations: CombinationRule[];
  crossConstructMandatories: MandatoryRule[];
  runtimeFeasibilityChecks: FeasibilityCheckSpec[];
}
