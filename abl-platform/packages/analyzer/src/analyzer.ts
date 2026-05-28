/**
 * Main analyzer module
 */

import type { SupervisorDocument, AgentDocument, AgentBasedDocument } from '@abl/core';
import type {
  AnalysisRule,
  AnalysisResult,
  AnalysisContext,
  ProjectContext,
  ProjectConfig,
  AnalysisReport,
  AnalysisSummary,
  AnyDocument,
} from './types.js';
import { allRules } from './rules/index.js';

/**
 * Analyzer configuration
 */
export interface AnalyzerConfig {
  rules?: AnalysisRule[];
  enabledRuleIds?: string[];
  disabledRuleIds?: string[];
  severityThreshold?: 'error' | 'warning' | 'info';
  /** Project-wide configuration for rules */
  projectConfig?: ProjectConfig;
}

/**
 * ABL Analyzer
 */
export class DSLAnalyzer {
  private rules: AnalysisRule[];
  private config: AnalyzerConfig;

  constructor(config: AnalyzerConfig = {}) {
    this.config = config;

    // Start with provided rules or all built-in rules
    let rules = config.rules ?? allRules;

    // Filter by enabled/disabled
    if (config.enabledRuleIds) {
      rules = rules.filter((r) => config.enabledRuleIds!.includes(r.id));
    }
    if (config.disabledRuleIds) {
      rules = rules.filter((r) => !config.disabledRuleIds!.includes(r.id));
    }

    this.rules = rules;
  }

  /**
   * Analyze a single supervisor document
   */
  analyzeSupervisor(doc: SupervisorDocument, allDocs?: Map<string, AnyDocument>): AnalysisResult[] {
    const context: AnalysisContext = {
      document: doc,
      allDocuments: allDocs ?? new Map([[doc.meta.name, doc]]),
      projectConfig: this.config.projectConfig,
    };

    const results: AnalysisResult[] = [];

    for (const rule of this.rules) {
      if (rule.checkSupervisor) {
        try {
          const ruleResults = rule.checkSupervisor(doc, context);
          results.push(...ruleResults);
        } catch (error) {
          results.push({
            ruleId: rule.id,
            severity: 'error',
            message: `Rule "${rule.id}" threw an error: ${error instanceof Error ? error.message : String(error)}`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
            },
          });
        }
      }
    }

    return this.filterBySeverity(results);
  }

  /**
   * Analyze a single agent document (old format)
   */
  analyzeAgent(doc: AgentDocument, allDocs?: Map<string, AnyDocument>): AnalysisResult[] {
    const context: AnalysisContext = {
      document: doc,
      allDocuments: allDocs ?? new Map([[doc.meta.name, doc]]),
      projectConfig: this.config.projectConfig,
    };

    const results: AnalysisResult[] = [];

    for (const rule of this.rules) {
      if (rule.checkAgent) {
        try {
          const ruleResults = rule.checkAgent(doc, context);
          results.push(...ruleResults);
        } catch (error) {
          results.push({
            ruleId: rule.id,
            severity: 'error',
            message: `Rule "${rule.id}" threw an error: ${error instanceof Error ? error.message : String(error)}`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
            },
          });
        }
      }
    }

    return this.filterBySeverity(results);
  }

  /**
   * Analyze a single agent-based document (new unified format)
   */
  analyzeAgentBased(doc: AgentBasedDocument, allDocs?: Map<string, AnyDocument>): AnalysisResult[] {
    const context: AnalysisContext = {
      document: doc,
      allDocuments: allDocs ?? new Map([[doc.meta.name, doc]]),
      projectConfig: this.config.projectConfig,
    };

    const results: AnalysisResult[] = [];

    for (const rule of this.rules) {
      if (rule.checkAgentBased) {
        try {
          const ruleResults = rule.checkAgentBased(doc, context);
          results.push(...ruleResults);
        } catch (error) {
          results.push({
            ruleId: rule.id,
            severity: 'error',
            message: `Rule "${rule.id}" threw an error: ${error instanceof Error ? error.message : String(error)}`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
            },
          });
        }
      }
    }

    return this.filterBySeverity(results);
  }

  /**
   * Analyze an entire project
   */
  analyzeProject(
    supervisor: SupervisorDocument | null,
    agents: Map<string, AgentDocument>,
    agentBased: Map<string, AgentBasedDocument> = new Map(),
  ): AnalysisReport {
    const allResults: AnalysisResult[] = [];
    const allDocs = new Map<string, AnyDocument>();

    // Build document map
    if (supervisor) {
      allDocs.set(supervisor.meta.name, supervisor);
    }
    for (const [name, agent] of agents) {
      allDocs.set(name, agent);
    }
    for (const [name, agent] of agentBased) {
      allDocs.set(name, agent);
    }

    // Analyze supervisor
    if (supervisor) {
      const results = this.analyzeSupervisor(supervisor, allDocs);
      allResults.push(...results);
    }

    // Analyze each old-style agent
    for (const [, agent] of agents) {
      const results = this.analyzeAgent(agent, allDocs);
      allResults.push(...results);
    }

    // Analyze each agent-based agent
    for (const [, agent] of agentBased) {
      const results = this.analyzeAgentBased(agent, allDocs);
      allResults.push(...results);
    }

    // Run project-level checks
    const projectContext: ProjectContext = {
      supervisor,
      agents,
      agentBased,
      allDocuments: allDocs,
    };

    for (const rule of this.rules) {
      if (rule.checkProject) {
        try {
          const ruleResults = rule.checkProject(projectContext);
          allResults.push(...this.filterBySeverity(ruleResults));
        } catch (error) {
          allResults.push({
            ruleId: rule.id,
            severity: 'error',
            message: `Rule "${rule.id}" threw an error during project analysis: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    return this.buildReport(allResults, allDocs);
  }

  /**
   * Filter results by severity threshold
   */
  private filterBySeverity(results: AnalysisResult[]): AnalysisResult[] {
    const threshold = this.config.severityThreshold;
    if (!threshold) return results;

    const severityOrder = { error: 0, warning: 1, info: 2 };
    const thresholdValue = severityOrder[threshold];

    return results.filter((r) => severityOrder[r.severity] <= thresholdValue);
  }

  /**
   * Build analysis report
   */
  private buildReport(
    results: AnalysisResult[],
    allDocs: Map<string, AnyDocument>,
  ): AnalysisReport {
    // Group by document
    const byDocument = new Map<string, AnalysisResult[]>();
    for (const result of results) {
      const docName = result.location?.documentName ?? 'unknown';
      if (!byDocument.has(docName)) {
        byDocument.set(docName, []);
      }
      byDocument.get(docName)!.push(result);
    }

    // Group by rule
    const byRule = new Map<string, AnalysisResult[]>();
    for (const result of results) {
      if (!byRule.has(result.ruleId)) {
        byRule.set(result.ruleId, []);
      }
      byRule.get(result.ruleId)!.push(result);
    }

    // Calculate summary
    const failedRuleIds = new Set(results.map((r) => r.ruleId));
    const passedRules = this.rules.filter((r) => !failedRuleIds.has(r.id)).map((r) => r.id);

    const summary: AnalysisSummary = {
      totalErrors: results.filter((r) => r.severity === 'error').length,
      totalWarnings: results.filter((r) => r.severity === 'warning').length,
      totalInfos: results.filter((r) => r.severity === 'info').length,
      totalDocuments: allDocs.size,
      passedRules,
      failedRules: Array.from(failedRuleIds),
    };

    return {
      timestamp: new Date(),
      results,
      summary,
      byDocument,
      byRule,
    };
  }

  /**
   * Get all configured rules
   */
  getRules(): AnalysisRule[] {
    return [...this.rules];
  }

  /**
   * Add a custom rule
   */
  addRule(rule: AnalysisRule): void {
    this.rules.push(rule);
  }

  /**
   * Remove a rule by ID
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index >= 0) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }
}

/**
 * Create a new analyzer with default configuration
 */
export function createAnalyzer(config?: AnalyzerConfig): DSLAnalyzer {
  return new DSLAnalyzer(config);
}

/**
 * Quick analysis function for a single document
 */
export function analyze(doc: AnyDocument, config?: AnalyzerConfig): AnalysisResult[] {
  const analyzer = new DSLAnalyzer(config);

  if (doc.meta.kind === 'supervisor') {
    return analyzer.analyzeSupervisor(doc as SupervisorDocument);
  } else if (doc.meta.kind === 'agent-based') {
    return analyzer.analyzeAgentBased(doc as AgentBasedDocument);
  } else {
    return analyzer.analyzeAgent(doc as AgentDocument);
  }
}
