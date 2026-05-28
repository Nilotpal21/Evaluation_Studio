/**
 * Analysis rules exports
 */

export * from './conflicts.js';
export * from './coverage.js';
export * from './security.js';
export * from './agent-based.js';

import { conflictRules } from './conflicts.js';
import { coverageRules } from './coverage.js';
import { securityRules } from './security.js';
import { agentBasedRules } from './agent-based.js';
import type { AnalysisRule } from '../types.js';

/**
 * All built-in analysis rules
 */
export const allRules: AnalysisRule[] = [
  ...conflictRules,
  ...coverageRules,
  ...securityRules,
  ...agentBasedRules,
];

/**
 * Get rules by category
 */
export function getRulesByCategory(
  category: 'conflict' | 'coverage' | 'security' | 'style',
): AnalysisRule[] {
  return allRules.filter((rule) => rule.category === category);
}

/**
 * Get rule by ID
 */
export function getRuleById(id: string): AnalysisRule | undefined {
  return allRules.find((rule) => rule.id === id);
}
