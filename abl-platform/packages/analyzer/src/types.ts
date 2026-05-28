/**
 * Analyzer types and interfaces
 */

import type { SupervisorDocument, AgentDocument, AgentBasedDocument, ElementId } from '@abl/core';

/**
 * Union of all analyzable agent document types
 */
export type AnyAgentDocument = AgentDocument | AgentBasedDocument;

/**
 * Union of all analyzable document types
 */
export type AnyDocument = SupervisorDocument | AnyAgentDocument;

/**
 * Severity levels for analysis results
 */
export type Severity = 'error' | 'warning' | 'info';

/**
 * Location in a ABL document
 */
export interface SourceLocation {
  documentId: ElementId;
  documentName: string;
  line?: number;
  column?: number;
  elementId?: ElementId;
  elementName?: string;
}

/**
 * Single analysis result
 */
export interface AnalysisResult {
  ruleId: string;
  severity: Severity;
  message: string;
  location?: SourceLocation;
  suggestion?: string;
  relatedLocations?: SourceLocation[];
}

/**
 * Analysis rule interface
 */
export interface AnalysisRule {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  category: 'conflict' | 'coverage' | 'security' | 'style';

  /**
   * Check a supervisor document
   */
  checkSupervisor?(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[];

  /**
   * Check an agent document (old format with Step objects)
   */
  checkAgent?(doc: AgentDocument, context: AnalysisContext): AnalysisResult[];

  /**
   * Check an agent-based document (new unified format with FlowDefinition)
   */
  checkAgentBased?(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[];

  /**
   * Check cross-document relationships
   */
  checkProject?(project: ProjectContext): AnalysisResult[];
}

/**
 * Schedule constraint configuration (for CONF005)
 */
export interface ScheduleConstraintConfig {
  /** Variables that indicate schedule-based unavailability */
  scheduleVariables?: string[];
  /** Action types that should check schedule constraints */
  timeGatedActionTypes?: string[];
  /** Whether this rule is enabled (default: false) */
  enabled: boolean;
}

/**
 * Project-wide analyzer configuration
 */
export interface ProjectConfig {
  /** Strict mode enables additional checks */
  strictMode?: boolean;
  /** Custom rules to add */
  customRules?: AnalysisRule[];
  /** Schedule constraint configuration (opt-in) */
  scheduleConstraints?: ScheduleConstraintConfig;
  /** Rule-specific overrides */
  ruleOverrides?: Record<
    string,
    {
      enabled?: boolean;
      severity?: Severity;
    }
  >;
}

/**
 * Context for single-document analysis
 */
export interface AnalysisContext {
  document: AnyDocument;
  allDocuments: Map<string, AnyDocument>;
  projectConfig?: ProjectConfig;
}

/**
 * Context for project-wide analysis
 */
export interface ProjectContext {
  supervisor: SupervisorDocument | null;
  /** Old-style agents (AgentDocument with Step objects) */
  agents: Map<string, AgentDocument>;
  /** New-style agents (AgentBasedDocument with FlowDefinition) */
  agentBased: Map<string, AgentBasedDocument>;
  allDocuments: Map<string, AnyDocument>;
}

/**
 * Summary of analysis results
 */
export interface AnalysisSummary {
  totalErrors: number;
  totalWarnings: number;
  totalInfos: number;
  totalDocuments: number;
  passedRules: string[];
  failedRules: string[];
}

/**
 * Complete analysis report
 */
export interface AnalysisReport {
  timestamp: Date;
  results: AnalysisResult[];
  summary: AnalysisSummary;
  byDocument: Map<string, AnalysisResult[]>;
  byRule: Map<string, AnalysisResult[]>;
}
