import type { CombinationRule } from './types.js';

/**
 * Valid-combinations matrix.
 *
 * `coverage: 'enforced'` means an existing compiler validator catches the
 * violation. `coverage: 'advisory'` means the rule is exposed to Arch AI but
 * awaits validator codification.
 */
export const VALID_COMBINATIONS: readonly CombinationRule[] = [
  {
    ruleId: 'HANDOFF_ON_RETURN_REQUIRES_RETURN_TRUE',
    constructA: 'HANDOFF',
    constructB: 'HANDOFF',
    relation: 'requires',
    validatorCode: 'HANDOFF_ON_RETURN_WITHOUT_RETURN',
    coverage: 'enforced',
    rationale:
      'on_return action/handler requires RETURN: true on the parent handoff. Without RETURN: true the on_return branch is unreachable.',
  },
  {
    ruleId: 'HANDOFF_ON_RETURN_ACTION_OR_HANDLER_NOT_BOTH',
    constructA: 'HANDOFF',
    constructB: 'HANDOFF',
    relation: 'mutually-exclusive',
    validatorCode: 'HANDOFF_ON_RETURN_ACTION_AND_HANDLER',
    coverage: 'enforced',
    rationale: 'on_return must be either an action or a handler reference, never both.',
  },
  {
    ruleId: 'HANDOFF_SUMMARY_ONLY_REQUIRES_SUMMARY',
    constructA: 'HANDOFF',
    constructB: 'HANDOFF',
    relation: 'requires',
    validatorCode: 'HANDOFF_SUMMARY_ONLY_WITHOUT_SUMMARY',
    coverage: 'enforced',
    rationale: 'history: summary_only requires a summary field declared on the handoff.',
  },
  {
    ruleId: 'FLOW_REPLACE_VS_FLOW_MODIFICATIONS_MUTUAL_EXCLUSION',
    constructA: 'FLOW',
    constructB: 'FLOW',
    relation: 'mutually-exclusive',
    coverage: 'enforced',
    rationale: 'A behavior profile cannot specify both flow_replace and flow_modifications.',
  },
  {
    ruleId: 'DELEGATE_TARGET_NEEDS_COMPLETE',
    constructA: 'DELEGATE',
    constructB: 'COMPLETE',
    relation: 'requires',
    coverage: 'advisory',
    rationale:
      'A DELEGATE target agent needs an explicit COMPLETE condition or return mapping for the delegating agent to receive control back.',
  },
  {
    ruleId: 'RETURN_TRUE_TARGET_NEEDS_COMPLETE',
    constructA: 'HANDOFF',
    constructB: 'COMPLETE',
    relation: 'requires',
    coverage: 'advisory',
    rationale:
      'When a HANDOFF declares RETURN: true, the target agent needs a COMPLETE condition so control returns to the caller.',
  },
  {
    ruleId: 'SUPERVISOR_NEEDS_CATCH_ALL_HANDOFF',
    constructA: 'SUPERVISOR',
    constructB: 'HANDOFF',
    relation: 'requires',
    coverage: 'advisory',
    rationale:
      'A supervisor should declare a catch-all handoff with WHEN: true to avoid stuck routing.',
  },
];
