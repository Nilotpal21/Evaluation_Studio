/**
 * Agent-Based Document specific rules
 *
 * AB001: Missing constraint handlers
 * AB002: Incomplete escalation config
 * AB003: Handoff without return handler
 * AB004: Missing complete conditions
 * AB005: Delegate timeout missing
 * AB006: Unreferenced gather fields
 * AB007: Invalid step references
 */

import type { AnalysisRule, AnalysisResult, AnalysisContext } from '../types.js';
import type {
  AgentBasedDocument,
  FlowStep,
  ConstraintPhase,
  HandoffConfig,
  DelegateConfig,
  EscalateConfig,
} from '@abl/core';

/**
 * AB001: Missing constraint handlers
 * Detects constraint phases without proper failure handlers
 */
export const missingConstraintHandlers: AnalysisRule = {
  id: 'AB001',
  name: 'Missing Constraint Handlers',
  description: 'Detects constraint requirements without proper on-fail handlers',
  severity: 'warning',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    for (const phase of doc.constraints) {
      for (const requirement of phase.requirements) {
        // Check if onFail is just a string (simple message) vs a proper action
        if (
          typeof requirement.onFail === 'string' &&
          !requirement.onFail.includes('escalate') &&
          !requirement.onFail.includes('handoff')
        ) {
          // Simple string response - might be insufficient for critical constraints
          if (
            phase.name.toLowerCase().includes('critical') ||
            phase.name.toLowerCase().includes('security') ||
            phase.name.toLowerCase().includes('auth')
          ) {
            results.push({
              ruleId: 'AB001',
              severity: 'warning',
              message: `Critical constraint "${requirement.condition}" in phase "${phase.name}" has only a simple message handler`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementName: phase.name,
              },
              suggestion: 'Consider using escalate or block actions for critical constraints',
            });
          }
        }
      }
    }

    return results;
  },
};

/**
 * AB002: Incomplete escalation config
 * Detects escalation configurations missing required fields
 */
export const incompleteEscalation: AnalysisRule = {
  id: 'AB002',
  name: 'Incomplete Escalation Config',
  description: 'Detects escalation configurations missing context or handlers',
  severity: 'warning',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.escalate) return results;

    const escalate = doc.escalate;

    // Check for triggers without proper priority
    for (const trigger of escalate.triggers) {
      if (!trigger.priority) {
        results.push({
          ruleId: 'AB002',
          severity: 'info',
          message: `Escalation trigger "${trigger.reason}" has no priority set`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Set priority (low, medium, high, critical) for proper escalation routing',
        });
      }
    }

    // Check for context for human
    if (escalate.contextForHuman.length === 0) {
      results.push({
        ruleId: 'AB002',
        severity: 'warning',
        message: 'Escalation has no context_for_human defined',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion: 'Add context_for_human to provide useful information to human agents',
      });
    }

    // Check for on_human_complete handlers
    if (escalate.onHumanComplete.length === 0) {
      results.push({
        ruleId: 'AB002',
        severity: 'info',
        message: 'Escalation has no on_human_complete handlers',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion: 'Consider adding on_human_complete handlers to resume after human intervention',
      });
    }

    return results;
  },
};

/**
 * AB003: Handoff without return handler
 * Detects handoffs with return:true but no onReturn handler
 */
export const handoffReturnHandler: AnalysisRule = {
  id: 'AB003',
  name: 'Handoff Return Handler',
  description: 'Detects handoffs expecting return but lacking return handlers',
  severity: 'warning',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    for (const handoff of doc.handoff) {
      if (handoff.return && !handoff.onReturn) {
        results.push({
          ruleId: 'AB003',
          severity: 'warning',
          message: `Handoff to "${handoff.to}" has return:true but no on_return handler`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Add on_return handler to process results from the target agent',
        });
      }

      // Check context.pass for empty array
      if (handoff.context.pass.length === 0) {
        results.push({
          ruleId: 'AB003',
          severity: 'info',
          message: `Handoff to "${handoff.to}" passes no context data`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Consider passing relevant context data for smoother handoff',
        });
      }
    }

    return results;
  },
};

/**
 * AB004: Missing complete conditions
 * Detects agents without clear completion conditions
 */
export const missingCompleteConditions: AnalysisRule = {
  id: 'AB004',
  name: 'Missing Complete Conditions',
  description: 'Detects agents without defined completion conditions',
  severity: 'warning',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // In flow-based agents, completion is typically via THEN: COMPLETE in flow
    if (doc.flow) {
      // Check if any step leads to COMPLETE
      let hasCompletePath = false;
      for (const step of Object.values(doc.flow.definitions)) {
        if (step.then?.toUpperCase() === 'COMPLETE') {
          hasCompletePath = true;
          break;
        }
        if (step.onInput?.some((b) => b.then?.toUpperCase() === 'COMPLETE')) {
          hasCompletePath = true;
          break;
        }
      }

      if (!hasCompletePath && doc.complete.length === 0) {
        results.push({
          ruleId: 'AB004',
          severity: 'warning',
          message: 'Scripted agent has no path to COMPLETE in flow',
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Add THEN: COMPLETE to at least one step or define COMPLETE conditions',
        });
      }
    }

    // In reasoning-only agents, COMPLETE section is important
    if (!doc.flow && doc.complete.length === 0) {
      results.push({
        ruleId: 'AB004',
        severity: 'warning',
        message: 'Reasoning agent has no COMPLETE conditions defined',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion: 'Define COMPLETE conditions to indicate when the agent should finish',
      });
    }

    return results;
  },
};

/**
 * AB005: Delegate timeout missing
 * Detects delegate configurations without timeout
 */
export const delegateTimeoutMissing: AnalysisRule = {
  id: 'AB005',
  name: 'Delegate Timeout Missing',
  description: 'Detects delegate configurations without timeout or failure handlers',
  severity: 'info',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    for (const delegate of doc.delegate) {
      if (!delegate.timeout) {
        results.push({
          ruleId: 'AB005',
          severity: 'info',
          message: `Delegate to "${delegate.agent}" has no timeout configured`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Set a timeout to prevent indefinite waiting for sub-agent',
        });
      }

      if (!delegate.onFailure) {
        results.push({
          ruleId: 'AB005',
          severity: 'info',
          message: `Delegate to "${delegate.agent}" has no on_failure handler`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: 'Add on_failure handler to gracefully handle sub-agent failures',
        });
      }
    }

    return results;
  },
};

/**
 * AB006: Unreferenced gather fields
 * Detects gather fields that are never used in flow or constraints
 */
export const unreferencedGatherFields: AnalysisRule = {
  id: 'AB006',
  name: 'Unreferenced Gather Fields',
  description: 'Detects gather fields that are defined but never referenced',
  severity: 'info',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    const gatherFieldNames = new Set(doc.gather.map((f) => f.name));
    const referencedFields = new Set<string>();

    // Collect references from flow
    if (doc.flow) {
      for (const step of Object.values(doc.flow.definitions)) {
        // GATHER fields referenced within flow steps
        if (step.gather?.fields) {
          for (const field of step.gather.fields) {
            referencedFields.add(field.name);
          }
        }

        // Check templates in respond and gather field prompts for {{field}} references
        const templatePattern = /\{\{(\w+)\}\}/g;
        if (step.respond) {
          let match;
          while ((match = templatePattern.exec(step.respond)) !== null) {
            referencedFields.add(match[1]);
          }
        }
        if (step.gather?.fields) {
          for (const field of step.gather.fields) {
            if (field.prompt) {
              let match;
              while ((match = templatePattern.exec(field.prompt)) !== null) {
                referencedFields.add(match[1]);
              }
            }
          }
        }
      }
    }

    // Collect references from constraints
    for (const phase of doc.constraints) {
      for (const req of phase.requirements) {
        // Check condition for field references
        for (const fieldName of gatherFieldNames) {
          if (req.condition.includes(fieldName)) {
            referencedFields.add(fieldName);
          }
        }
      }
    }

    // Collect references from complete conditions
    for (const condition of doc.complete) {
      for (const fieldName of gatherFieldNames) {
        if (condition.when.includes(fieldName)) {
          referencedFields.add(fieldName);
        }
      }
    }

    // Find unreferenced fields
    for (const field of doc.gather) {
      if (!referencedFields.has(field.name)) {
        results.push({
          ruleId: 'AB006',
          severity: 'info',
          message: `Gather field "${field.name}" is defined but never referenced`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: field.name,
          },
          suggestion: 'Remove unused gather field or add references in flow/constraints',
        });
      }
    }

    return results;
  },
};

/**
 * AB007: Invalid step references
 * Detects references to non-existent steps in flow
 */
export const invalidStepReferences: AnalysisRule = {
  id: 'AB007',
  name: 'Invalid Step References',
  description: 'Detects references to steps that do not exist',
  severity: 'error',
  category: 'coverage',

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.flow) return results;

    const validSteps = new Set(Object.keys(doc.flow.definitions));
    validSteps.add('COMPLETE'); // COMPLETE is always valid

    // Check steps list references definitions
    for (const stepName of doc.flow.steps) {
      if (!validSteps.has(stepName)) {
        results.push({
          ruleId: 'AB007',
          severity: 'error',
          message: `Step "${stepName}" is listed in steps but not defined`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
          },
          suggestion: `Add a definition for step "${stepName}"`,
        });
      }
    }

    // Check all THEN references
    for (const [stepName, step] of Object.entries(doc.flow.definitions)) {
      if (step.then && !validSteps.has(step.then)) {
        results.push({
          ruleId: 'AB007',
          severity: 'error',
          message: `Step "${stepName}" references undefined step "${step.then}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: `Define step "${step.then}" or fix the reference`,
        });
      }

      if (step.onFail && !validSteps.has(step.onFail)) {
        results.push({
          ruleId: 'AB007',
          severity: 'error',
          message: `Step "${stepName}" ON_FAIL references undefined step "${step.onFail}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: `Define step "${step.onFail}" or fix the reference`,
        });
      }

      if (step.onInput) {
        for (const branch of step.onInput) {
          if (branch.then && !validSteps.has(branch.then)) {
            results.push({
              ruleId: 'AB007',
              severity: 'error',
              message: `Step "${stepName}" ON_INPUT branch references undefined step "${branch.then}"`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementName: stepName,
              },
              suggestion: `Define step "${branch.then}" or fix the reference`,
            });
          }
        }
      }
    }

    return results;
  },
};

/**
 * Export all agent-based rules
 */
export const agentBasedRules: AnalysisRule[] = [
  missingConstraintHandlers,
  incompleteEscalation,
  handoffReturnHandler,
  missingCompleteConditions,
  delegateTimeoutMissing,
  unreferencedGatherFields,
  invalidStepReferences,
];
