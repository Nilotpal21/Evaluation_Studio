/**
 * Conflict detection rules
 *
 * CONF001: Contradictory conditions in routing table
 * CONF002: Policy contradictions
 * CONF003: Unreachable routing rules
 * CONF004: Missing default routing
 * CONF005: Business hours conflicts
 */

import type { AnalysisRule, AnalysisResult, AnalysisContext, ProjectContext } from '../types.js';
import type { SupervisorDocument, RoutingRule, Expression, Condition } from '@abl/core';
import { expressionToString, isWildcard } from '@abl/core';

/**
 * CONF001: Contradictory conditions
 * Detects routing rules with conditions that cannot both be true
 */
export const contradictoryConditions: AnalysisRule = {
  id: 'CONF001',
  name: 'Contradictory Conditions',
  description: 'Detects routing rules with mutually exclusive conditions at different priorities',
  severity: 'warning',
  category: 'conflict',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const rules = doc.routing;

    // Compare each pair of rules
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const rule1 = rules[i];
        const rule2 = rules[j];

        // Check for contradictory conditions
        if (areContradictory(rule1.when, rule2.when)) {
          results.push({
            ruleId: 'CONF001',
            severity: 'warning',
            message: `Routing rules "${rule1.name}" and "${rule2.name}" have contradictory conditions`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
              elementId: rule1.id,
              elementName: rule1.name,
            },
            suggestion: 'Consider merging these rules or clarifying the conditions',
            relatedLocations: [
              {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementId: rule2.id,
                elementName: rule2.name,
              },
            ],
          });
        }
      }
    }

    return results;
  },
};

/**
 * CONF002: Policy contradictions
 * Detects policies with conflicting allowed_when and forbidden_when conditions
 */
export const policyContradictions: AnalysisRule = {
  id: 'CONF002',
  name: 'Policy Contradictions',
  description: 'Detects policies with conflicting allowed and forbidden conditions',
  severity: 'error',
  category: 'conflict',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    for (const policy of doc.policies) {
      const { allowedWhen, forbiddenWhen } = policy.rules;

      if (allowedWhen && forbiddenWhen) {
        // Check if they can both be true (overlap)
        if (conditionsCanOverlap(allowedWhen, forbiddenWhen)) {
          results.push({
            ruleId: 'CONF002',
            severity: 'error',
            message: `Policy "${policy.name}" has overlapping allowed and forbidden conditions`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
              elementName: policy.name,
            },
            suggestion: 'Ensure allowed_when and forbidden_when conditions are mutually exclusive',
          });
        }
      }
    }

    return results;
  },
};

/**
 * CONF003: Unreachable routing rules
 * Detects rules that can never be reached due to higher priority rules
 */
export const unreachableRules: AnalysisRule = {
  id: 'CONF003',
  name: 'Unreachable Routing Rules',
  description: 'Detects routing rules that are shadowed by higher priority rules',
  severity: 'warning',
  category: 'conflict',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const sortedRules = [...doc.routing].sort((a, b) => a.priority - b.priority);

    for (let i = 0; i < sortedRules.length; i++) {
      const currentRule = sortedRules[i];

      // Check if any higher priority rule completely shadows this one
      for (let j = 0; j < i; j++) {
        const higherPriorityRule = sortedRules[j];

        if (conditionSubsumes(higherPriorityRule.when, currentRule.when)) {
          results.push({
            ruleId: 'CONF003',
            severity: 'warning',
            message: `Routing rule "${currentRule.name}" (priority ${currentRule.priority}) is unreachable - shadowed by "${higherPriorityRule.name}" (priority ${higherPriorityRule.priority})`,
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
              elementId: currentRule.id,
              elementName: currentRule.name,
            },
            suggestion: `Consider removing this rule or adjusting priorities`,
            relatedLocations: [
              {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementId: higherPriorityRule.id,
                elementName: higherPriorityRule.name,
              },
            ],
          });
        }
      }
    }

    return results;
  },
};

/**
 * CONF004: Missing default routing
 * Detects when routing table doesn't have a catch-all rule
 */
export const missingDefaultRouting: AnalysisRule = {
  id: 'CONF004',
  name: 'Missing Default Routing',
  description: 'Detects when routing table lacks a catch-all fallback rule',
  severity: 'error',
  category: 'conflict',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // If using intent-based routing, no catch-all wildcard is required in routing table
    // Intent routing handles unmatched cases differently
    if (doc.intents && doc.intents.length > 0) {
      return results;
    }

    // Check for wildcard rule in explicit routing table
    const hasWildcard = doc.routing.some((rule) => isWildcard(rule.when));

    if (!hasWildcard && doc.routing.length > 0) {
      results.push({
        ruleId: 'CONF004',
        severity: 'error',
        message: 'Routing table lacks a catch-all rule (wildcard condition)',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion:
          'Add a routing rule with condition "*" at the lowest priority to handle unmatched cases',
      });
    }

    return results;
  },
};

/**
 * CONF005: Schedule constraint conflicts (Optional Rule)
 * Detects when time-gated actions don't account for scheduling constraints
 *
 * This rule is OPTIONAL and should be enabled via configuration when:
 * - Your system has time-based availability (business hours, shifts, etc.)
 * - Actions like handoffs depend on external resource availability
 *
 * Configuration:
 *   scheduleConstraintVariables: Variables that indicate unavailability
 *   timeGatedActions: Action types that require schedule checks
 */
export interface ScheduleConstraintConfig {
  /** Variables that indicate schedule-based unavailability (e.g., 'schedule.unavailable', 'outside_hours') */
  scheduleVariables: string[];
  /** Action types that should check schedule constraints (e.g., 'agent_handoff', 'escalate') */
  timeGatedActionTypes: string[];
  /** Whether this rule is enabled (default: false - opt-in) */
  enabled: boolean;
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConstraintConfig = {
  scheduleVariables: [
    'schedule.unavailable',
    'outside_hours',
    'outside_business_hours',
    'after_hours',
  ],
  timeGatedActionTypes: ['agent_handoff', 'system_action'],
  enabled: false, // Opt-in by default
};

export const scheduleConstraintConflicts: AnalysisRule = {
  id: 'CONF005',
  name: 'Schedule Constraint Conflicts',
  description: 'Detects time-gated actions without schedule availability checks (optional rule)',
  severity: 'info', // Changed to info since it's optional
  category: 'conflict',

  checkSupervisor(doc: SupervisorDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Get configuration from project context or use defaults
    const config: ScheduleConstraintConfig = {
      ...DEFAULT_SCHEDULE_CONFIG,
      ...(context.projectConfig?.scheduleConstraints || {}),
    };

    // Skip if not enabled
    if (!config.enabled) {
      return [];
    }

    // Check for time-gated actions
    const timeGatedRules = doc.routing.filter((rule) =>
      config.timeGatedActionTypes.includes(rule.then.kind),
    );

    for (const rule of timeGatedRules) {
      // Check if the condition considers any schedule variable
      const conditionStr = expressionToString(rule.when);
      const hasScheduleCheck = config.scheduleVariables.some((v) => conditionStr.includes(v));

      if (!hasScheduleCheck) {
        results.push({
          ruleId: 'CONF005',
          severity: 'info',
          message: `Rule "${rule.name}" performs time-gated action without schedule availability check`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementId: rule.id,
            elementName: rule.name,
          },
          suggestion: `Consider adding a schedule check (e.g., ${config.scheduleVariables[0]}) if this action depends on resource availability`,
        });
      }
    }

    return results;
  },
};

// Helper functions

function areContradictory(cond1: Condition, cond2: Condition): boolean {
  // Simple check: if one is NOT X and other is X, they're contradictory
  if (cond1.kind === 'unary' && cond1.operator === 'not') {
    const inner = cond1.operand;
    if (expressionsEqual(inner, cond2)) {
      return true;
    }
  }

  if (cond2.kind === 'unary' && cond2.operator === 'not') {
    const inner = cond2.operand;
    if (expressionsEqual(inner, cond1)) {
      return true;
    }
  }

  // Check for X == A and X == B where A != B
  if (
    cond1.kind === 'binary' &&
    cond1.operator === '==' &&
    cond2.kind === 'binary' &&
    cond2.operator === '=='
  ) {
    if (expressionsEqual(cond1.left, cond2.left)) {
      if (!expressionsEqual(cond1.right, cond2.right)) {
        return true;
      }
    }
  }

  return false;
}

function conditionsCanOverlap(cond1: Condition, cond2: Condition): boolean {
  // Simplified check - if neither is the negation of the other, they might overlap
  return !areContradictory(cond1, cond2);
}

function conditionSubsumes(broader: Condition, narrower: Condition): boolean {
  // Wildcard subsumes everything
  if (isWildcard(broader)) {
    return true;
  }

  // Same condition subsumes itself
  if (expressionsEqual(broader, narrower)) {
    return true;
  }

  return false;
}

function expressionsEqual(e1: Expression, e2: Expression): boolean {
  // Simple string comparison for now
  return expressionToString(e1) === expressionToString(e2);
}

/**
 * Export all conflict rules
 * Note: CONF005 (scheduleConstraintConflicts) is opt-in and disabled by default
 */
export const conflictRules: AnalysisRule[] = [
  contradictoryConditions,
  policyContradictions,
  unreachableRules,
  missingDefaultRouting,
  scheduleConstraintConflicts,
];
