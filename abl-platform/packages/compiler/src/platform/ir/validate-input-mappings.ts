/**
 * INPUT Mapping Validation
 *
 * Detects CEL expressions in DELEGATE INPUT mappings and emits warnings.
 * INPUT only supports dot-path resolution. CEL expressions should use SET
 * before the DELEGATE to compute derived values.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

/** Patterns that indicate CEL syntax (not plain dot-paths) */
const CEL_INDICATORS = [
  /\(.*\)/, // Function calls: abl.upper(name)
  /&&|\|\|/, // Logical operators
  /\s[+*/]\s/, // Arithmetic operators (space-padded, excludes hyphenated paths)
  /\s-\s/, // Subtraction (space-padded, excludes kebab-case)
];

/**
 * Validate INPUT mappings for CEL expressions.
 * Returns warnings for any mapping source that appears to contain CEL syntax.
 */
export function validateInputMappings(
  inputMapping: Record<string, string>,
  agentName: string,
  delegateTarget: string,
  pathPrefix?: string,
): ValidationDiagnostic[] {
  const warnings: ValidationDiagnostic[] = [];

  for (const [key, source] of Object.entries(inputMapping)) {
    for (const pattern of CEL_INDICATORS) {
      if (pattern.test(source)) {
        warnings.push({
          type: 'validation',
          severity: 'warning',
          agent: agentName,
          code: VALIDATION_CODES.CEL_IN_INPUT_MAPPING,
          message:
            `INPUT mapping "${key}" in DELEGATE to "${delegateTarget}" appears to contain ` +
            `a CEL expression ("${source.slice(0, 60)}"). INPUT only supports dot-path ` +
            `resolution. Use SET before DELEGATE to compute transformed values.`,
          path: pathPrefix ? `${pathPrefix}.${key}` : undefined,
        });
        break; // One warning per field
      }
    }
  }

  return warnings;
}

export function validateInputMappingsForAgent(agent: AgentIR): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  for (let i = 0; i < (agent.coordination?.delegates?.length ?? 0); i++) {
    const delegate = agent.coordination!.delegates[i];
    diagnostics.push(
      ...validateInputMappings(
        delegate.input ?? {},
        agent.metadata.name,
        delegate.agent,
        `coordination.delegates[${i}].input`,
      ),
    );
  }

  return diagnostics;
}
