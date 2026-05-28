/**
 * Security analysis rules
 *
 * SEC001: PII detection in responses
 * SEC002: Missing authentication gates
 * SEC003: Handoff data protection
 */

import type { AnalysisRule, AnalysisResult, AnalysisContext, ProjectContext } from '../types.js';
import type {
  SupervisorDocument,
  AgentDocument,
  AgentBasedDocument,
  Step,
  StepAction,
  Expression,
  FlowStep,
} from '@abl/core';
import { expressionToString } from '@abl/core';

/**
 * SEC001: PII detection
 * Detects potential PII being logged or exposed in responses
 */
export const piiDetection: AnalysisRule = {
  id: 'SEC001',
  name: 'PII Detection',
  description: 'Detects potential PII exposure in agent responses',
  severity: 'warning',
  category: 'security',

  checkAgent(doc: AgentDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // PII patterns to check
    const piiPatterns = [
      { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
      { name: 'Credit Card', pattern: /\b\d{16}\b/ },
      { name: 'Email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ },
      { name: 'Phone', pattern: /\b\d{10}\b/ },
    ];

    // PII-sensitive variable names
    const piiVariables = [
      'cedula',
      'ssn',
      'social_security',
      'credit_card',
      'card_number',
      'password',
      'pin',
      'secret',
      'api_key',
      'token',
    ];

    for (const step of doc.flow.steps) {
      checkActionForPII(step.action, step, doc, piiPatterns, piiVariables, results);
    }

    // Check guardrails for PII protection
    const hasPIIGuardrail = doc.guardrails.some(
      (g) =>
        g.name.toLowerCase().includes('pii') ||
        (typeof g.check === 'string' && g.check.toLowerCase().includes('pii')),
    );

    if (!hasPIIGuardrail && results.length > 0) {
      results.push({
        ruleId: 'SEC001',
        severity: 'warning',
        message: 'Agent handles PII but lacks a PII-protection guardrail',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion: 'Add a guardrail to detect and redact PII in outputs',
      });
    }

    return results;
  },

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // PII patterns to check
    const piiPatterns = [
      { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
      { name: 'Credit Card', pattern: /\b\d{16}\b/ },
      { name: 'Email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ },
      { name: 'Phone', pattern: /\b\d{10}\b/ },
    ];

    // PII-sensitive variable names
    const piiVariables = [
      'cedula',
      'ssn',
      'social_security',
      'credit_card',
      'card_number',
      'password',
      'pin',
      'secret',
      'api_key',
      'token',
    ];

    // Check flow steps for PII in responses
    if (doc.flow) {
      for (const [stepName, step] of Object.entries(doc.flow.definitions)) {
        checkFlowStepForPII(step, stepName, doc, piiPatterns, piiVariables, results);
      }
    }

    // Check gather fields for sensitive names
    for (const field of doc.gather) {
      if (piiVariables.some((v) => field.name.toLowerCase().includes(v))) {
        results.push({
          ruleId: 'SEC001',
          severity: 'info',
          message: `Gather field "${field.name}" may contain sensitive PII`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: field.name,
          },
          suggestion: 'Ensure PII is handled securely and not exposed in responses',
        });
      }
    }

    return results;
  },
};

/**
 * SEC002: Missing authentication gates
 * Detects when sensitive operations are performed without validation
 */
export const missingAuthGates: AnalysisRule = {
  id: 'SEC002',
  name: 'Missing Authentication Gates',
  description: 'Detects sensitive operations without user validation',
  severity: 'error',
  category: 'security',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Sensitive agents that should require validation
    const sensitivePatterns = [
      'payment',
      'billing',
      'account',
      'personal',
      'sensitive',
      'transfer',
      'update',
      'delete',
      'modify',
    ];

    for (const rule of doc.routing) {
      if (rule.then.kind === 'route_to_agent') {
        const agentName = rule.then.agent.toLowerCase();

        // Check if routing to a sensitive agent
        const isSensitive = sensitivePatterns.some((p) => agentName.includes(p));

        if (isSensitive) {
          // Check if condition includes validation
          const conditionStr = expressionToString(rule.when).toLowerCase();
          const hasValidation =
            conditionStr.includes('is_validated') ||
            conditionStr.includes('authenticated') ||
            conditionStr.includes('verified');

          if (!hasValidation) {
            results.push({
              ruleId: 'SEC002',
              severity: 'error',
              message: `Routing to sensitive agent "${rule.then.agent}" without validation check`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementId: rule.id,
                elementName: rule.name,
              },
              suggestion: 'Add "user.is_validated" condition before routing to sensitive agents',
            });
          }
        }
      }
    }

    return results;
  },

  checkProject(project: ProjectContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!project.supervisor) return results;

    // Check each agent for sensitive tools
    for (const [agentName, agent] of project.agents) {
      const sensitiveTools = agent.tools.filter((tool) => {
        const name = tool.name.toLowerCase();
        return (
          name.includes('update') ||
          name.includes('delete') ||
          name.includes('modify') ||
          name.includes('payment') ||
          name.includes('transfer')
        );
      });

      if (sensitiveTools.length > 0) {
        // Check if this agent requires validation in supervisor
        const agentRef = project.supervisor.agents.find((a) => a.alias === agentName);
        if (agentRef && !agentRef.requiresValidation) {
          results.push({
            ruleId: 'SEC002',
            severity: 'warning',
            message: `Agent "${agentName}" has sensitive tools but "requiresValidation" is not set`,
            location: {
              documentId: agent.meta.id,
              documentName: agent.meta.name,
            },
            suggestion: 'Set "requiresValidation: true" in the agent reference',
          });
        }
      }
    }

    return results;
  },
};

/**
 * SEC003: Handoff data protection
 * Detects when sensitive data might be exposed during handoff
 */
export const handoffDataProtection: AnalysisRule = {
  id: 'SEC003',
  name: 'Handoff Data Protection',
  description: 'Detects potential data exposure during agent handoffs',
  severity: 'warning',
  category: 'security',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Check handoff actions for sensitive data
    for (const rule of doc.routing) {
      if (rule.then.kind === 'agent_handoff') {
        const params = rule.then.params;

        // Check for sensitive variables in handoff params
        for (const [key, value] of Object.entries(params)) {
          const valueStr = expressionToString(value).toLowerCase();

          if (
            valueStr.includes('password') ||
            valueStr.includes('pin') ||
            valueStr.includes('secret') ||
            valueStr.includes('token')
          ) {
            results.push({
              ruleId: 'SEC003',
              severity: 'error',
              message: `Sensitive data "${key}" may be exposed in handoff parameters`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementId: rule.id,
                elementName: rule.name,
              },
              suggestion: 'Avoid passing sensitive data in handoff parameters; use secure storage',
            });
          }
        }
      }
    }

    // Check transfer state variables
    const transferState = doc.state.transfer;
    if (transferState) {
      for (const [varName, varDef] of Object.entries(transferState)) {
        if (
          varName.toLowerCase().includes('password') ||
          varName.toLowerCase().includes('secret') ||
          varName.toLowerCase().includes('pin')
        ) {
          results.push({
            ruleId: 'SEC003',
            severity: 'warning',
            message: `Transfer state variable "${varName}" may contain sensitive data`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
            },
            suggestion: 'Use encrypted or reference-based storage for sensitive handoff data',
          });
        }
      }
    }

    return results;
  },
};

// Helper functions

function checkActionForPII(
  action: StepAction,
  step: Step,
  doc: AgentDocument,
  patterns: Array<{ name: string; pattern: RegExp }>,
  sensitiveVars: string[],
  results: AnalysisResult[],
): void {
  if (action.kind === 'respond') {
    const message = expressionToString(action.message);

    // Check for PII patterns in static strings
    for (const { name, pattern } of patterns) {
      if (pattern.test(message)) {
        results.push({
          ruleId: 'SEC001',
          severity: 'warning',
          message: `Potential ${name} pattern detected in response at step "${step.name}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementId: step.id,
            elementName: step.name,
          },
          suggestion: 'Ensure PII is not hardcoded and is properly redacted in outputs',
        });
      }
    }

    // Check for sensitive variables being echoed
    for (const varName of sensitiveVars) {
      if (message.toLowerCase().includes(varName)) {
        results.push({
          ruleId: 'SEC001',
          severity: 'warning',
          message: `Sensitive variable "${varName}" may be exposed in response at step "${step.name}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementId: step.id,
            elementName: step.name,
          },
          suggestion: 'Avoid echoing sensitive variables in user-facing responses',
        });
      }
    }
  } else if (action.kind === 'multi_step') {
    for (const subAction of action.steps) {
      checkActionForPII(subAction, step, doc, patterns, sensitiveVars, results);
    }
  } else if (action.kind === 'condition') {
    checkActionForPII(action.then, step, doc, patterns, sensitiveVars, results);
    if (action.else) {
      checkActionForPII(action.else, step, doc, patterns, sensitiveVars, results);
    }
  }
}

// =============================================================================
// AGENT-BASED HELPERS
// =============================================================================

/**
 * Check AgentBasedDocument flow step for PII
 */
function checkFlowStepForPII(
  step: FlowStep,
  stepName: string,
  doc: AgentBasedDocument,
  patterns: Array<{ name: string; pattern: RegExp }>,
  sensitiveVars: string[],
  results: AnalysisResult[],
): void {
  // Check RESPOND text
  if (step.respond) {
    for (const { name, pattern } of patterns) {
      if (pattern.test(step.respond)) {
        results.push({
          ruleId: 'SEC001',
          severity: 'warning',
          message: `Potential ${name} pattern detected in RESPOND at step "${stepName}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: 'Ensure PII is not hardcoded and is properly redacted in outputs',
        });
      }
    }

    for (const varName of sensitiveVars) {
      if (step.respond.toLowerCase().includes(varName)) {
        results.push({
          ruleId: 'SEC001',
          severity: 'warning',
          message: `Sensitive variable "${varName}" may be exposed in RESPOND at step "${stepName}"`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: 'Avoid echoing sensitive variables in user-facing responses',
        });
      }
    }
  }

  // Check GATHER field prompts
  if (step.gather?.fields) {
    for (const field of step.gather.fields) {
      if (field.prompt) {
        for (const varName of sensitiveVars) {
          if (field.prompt.toLowerCase().includes(varName)) {
            results.push({
              ruleId: 'SEC001',
              severity: 'info',
              message: `Sensitive variable "${varName}" referenced in GATHER field prompt at step "${stepName}"`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementName: stepName,
              },
              suggestion: 'Ensure sensitive data is not displayed to users unnecessarily',
            });
          }
        }
      }
    }
  }

  // Check ON_INPUT branches
  if (step.onInput) {
    for (const branch of step.onInput) {
      if (branch.respond) {
        for (const varName of sensitiveVars) {
          if (branch.respond.toLowerCase().includes(varName)) {
            results.push({
              ruleId: 'SEC001',
              severity: 'warning',
              message: `Sensitive variable "${varName}" may be exposed in ON_INPUT response at step "${stepName}"`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementName: stepName,
              },
              suggestion: 'Avoid echoing sensitive variables in user-facing responses',
            });
          }
        }
      }
    }
  }
}

/**
 * Export all security rules
 */
export const securityRules: AnalysisRule[] = [
  piiDetection,
  missingAuthGates,
  handoffDataProtection,
];
