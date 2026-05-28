/**
 * Diagnostic engine types — pure data types for validation results.
 * Imported by semantic-validators, pattern-analyzer, and diagnostic-engine.
 *
 * These types are arch-ai-local. The engine imports AgentIR and
 * ValidationDiagnostic from @abl/compiler for structural checks only.
 */

/** Severity levels — ordered by priority for sorting/filtering. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Diagnostic category — groups related rules for section-based reporting. */
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

/**
 * A single diagnostic finding from a validator.
 * Each finding maps to one or more rule codes from the registry.
 */
export interface Finding {
  /** Machine-readable rule code, e.g. 'H-01', 'SV-03', 'T-05'. */
  code: string;
  /** Human-readable description of the issue. */
  message: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  /** Agent this finding applies to (null for cross-agent findings). */
  agentName: string | null;
  /** Optional IR path to the problematic construct. */
  path?: string;
  /** Optional fix suggestion with template code. */
  fix?: FixSuggestion;
}

/**
 * Fix suggestion with ABL code example.
 */
export interface FixSuggestion {
  /** Short description of what to do. */
  description: string;
  /** ABL code snippet showing the fix (may include placeholders like <agent_name>). */
  template?: string;
  /** Estimated effort: S = <5 min, M = 5-30 min, L = >30 min. */
  effort: 'S' | 'M' | 'L';
}

/**
 * A section in the diagnostic report — groups findings by category.
 */
export interface DiagnosticSection {
  category: DiagnosticCategory;
  label: string;
  findings: Finding[];
  /** Computed from findings: worst severity in this section. */
  severity: DiagnosticSeverity;
}

/**
 * Architecture pattern classification for the project.
 */
export type ArchitecturePattern =
  | 'single-agent'
  | 'hub-spoke'
  | 'pipeline'
  | 'mesh'
  | 'triage'
  | 'hierarchical'
  | 'unknown';

/**
 * Anti-pattern detected in the project.
 */
export interface AntiPattern {
  /** Pattern name, e.g. 'overloaded-agent', 'supervisor-with-logic'. */
  name: string;
  /** Explanation of why this is problematic. */
  description: string;
  /** Affected agents. */
  agents: string[];
  severity: DiagnosticSeverity;
  fix?: FixSuggestion;
}

/**
 * Full diagnostic report returned by the engine.
 */
export interface DiagnosticReport {
  /** ISO timestamp of when the report was generated. */
  generatedAt: string;
  /** Overall severity — worst finding in the report. */
  overallSeverity: DiagnosticSeverity;
  /** Total findings by severity. */
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    total: number;
  };
  /** Grouped findings by category. */
  sections: DiagnosticSection[];
  /** Top N most impactful findings (sorted by severity then category priority). */
  topIssues: Finding[];
  /** Distinct error codes across the full filtered report before truncation. */
  errorCodes: string[];
  /** Distinct warning codes across the full filtered report before truncation. */
  warningCodes: string[];
  /** Architecture pattern classification. */
  architecturePattern: ArchitecturePattern;
  /** Anti-patterns detected. */
  antiPatterns: AntiPattern[];
  /** Per-agent error counts. */
  agentSummary: Record<string, { errors: number; warnings: number; infos: number }>;
  /** True when maxFindings limit caused findings to be dropped. */
  isTruncated: boolean;
  /** Total findings before truncation (may exceed summary.total when truncated). */
  totalFindings: number;
}

/**
 * Options for running the diagnostic engine.
 */
export interface DiagnosticOptions {
  /** Validation depth: 'quick' = Tier 1 only, 'deep' = all tiers. */
  depth: 'quick' | 'deep';
  /** Limit to a single agent (null = all agents). */
  agentName?: string | null;
  /** Focus on a specific category (null = all categories). */
  focus?: DiagnosticCategory | null;
  /** Maximum number of findings to return (default: 100). */
  maxFindings?: number;
  /**
   * Skip cross-agent pattern checks (orphaned agents, topology analysis) and
   * suppress missing-target cross-agent validation findings that are false
   * positives in single-agent compile output.
   * Auto-enabled when agentName is set.
   */
  skipCrossAgentPatterns?: boolean;
  /** Entry agent name from topology (for QG-05 validation) */
  entryAgent?: string;
}

/**
 * Context passed to validators — provides the compiled IR and project info.
 */
export interface ValidatorContext {
  /** All compiled agents in the project. */
  agents: Record<string, import('@abl/compiler').AgentIR>;
  /** Entry agent name (if resolved by compiler). */
  entryAgent?: string;
  /** All agent names for cross-reference validation. */
  agentNames: string[];
}

/**
 * A validator function signature — takes context, returns findings.
 * Every validator is a pure function (no side effects, no I/O).
 */
export type ValidatorFn = (ctx: ValidatorContext) => Finding[];

/**
 * Rule registry entry — metadata for a single diagnostic rule.
 */
export interface RuleEntry {
  code: string;
  description: string;
  impact: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  fixTemplate?: string;
  fixEffort: 'S' | 'M' | 'L';
}
