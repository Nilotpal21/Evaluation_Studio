/**
 * generateConstraints() — Maps regulations + sensitivity to ABL Constraint IR objects.
 * B23: Constraint & Guardrail Design Coaching
 *
 * Uses exact IR types from packages/compiler/src/platform/ir/schema.ts
 */

import type { SensitivityCategory } from './classify-data-sensitivity';

// =============================================================================
// TYPES (matching compiler IR schema.ts Constraint interface)
// =============================================================================

export interface ConstraintAction {
  type:
    | 'respond'
    | 'escalate'
    | 'handoff'
    | 'block'
    | 'redact'
    | 'retry_step'
    | 'goto_step'
    | 'collect_field';
  message?: string;
  target?: string;
  reason?: string;
}

export interface GeneratedConstraint {
  condition: string;
  on_fail: ConstraintAction;
  severity: 'error' | 'warning';
  kind: 'require' | 'limit' | 'restrict';
  checkpoint?: { kind: 'tool_call' | 'response'; target?: string };
}

export interface ConstraintGenerationInput {
  regulations: string[];
  sensitivity: SensitivityCategory[];
  agentRole: 'customer_facing' | 'internal' | 'supervisor';
  agentName: string;
}

// =============================================================================
// REGULATION → CONSTRAINT MAPPING TABLE
// =============================================================================

interface ConstraintTemplate {
  pattern: string;
  sensitivity: SensitivityCategory[];
  kind: 'require' | 'limit';
  severity: 'error' | 'warning';
  condition: string;
  guardrailTier: 'local' | 'model' | 'llm';
  checkpoint?: { kind: 'tool_call' | 'response' };
}

const REGULATION_TEMPLATES: Record<string, ConstraintTemplate[]> = {
  'PCI-DSS': [
    {
      pattern: 'credit_card_guard',
      sensitivity: ['payment'],
      kind: 'require',
      severity: 'error',
      condition: 'No credit card numbers in agent responses',
      guardrailTier: 'local',
      checkpoint: { kind: 'response' },
    },
    {
      pattern: 'payment_output_redaction',
      sensitivity: ['payment'],
      kind: 'require',
      severity: 'error',
      condition: 'Payment tool outputs must be redacted before display',
      guardrailTier: 'local',
      checkpoint: { kind: 'tool_call' },
    },
  ],
  HIPAA: [
    {
      pattern: 'pii_detection_health',
      sensitivity: ['health', 'pii'],
      kind: 'require',
      severity: 'error',
      condition: 'Health data and PII must be detected and protected',
      guardrailTier: 'model',
      checkpoint: { kind: 'response' },
    },
    {
      pattern: 'health_data_access_logging',
      sensitivity: ['health'],
      kind: 'require',
      severity: 'error',
      condition: 'All health data access must be logged for audit',
      guardrailTier: 'local',
    },
  ],
  GDPR: [
    {
      pattern: 'data_minimization',
      sensitivity: ['pii', 'payment', 'health', 'financial'],
      kind: 'limit',
      severity: 'warning',
      condition: 'Collect and process only the minimum data necessary',
      guardrailTier: 'model',
    },
    {
      pattern: 'consent_verification',
      sensitivity: ['pii'],
      kind: 'require',
      severity: 'error',
      condition: 'Verify user consent before processing personal data',
      guardrailTier: 'llm',
    },
  ],
  SOC2: [
    {
      pattern: 'access_control',
      sensitivity: ['payment', 'pii', 'health', 'financial'],
      kind: 'require',
      severity: 'error',
      condition: 'Verify access authorization before data operations',
      guardrailTier: 'llm',
    },
    {
      pattern: 'audit_trail',
      sensitivity: ['payment', 'pii', 'health', 'financial'],
      kind: 'limit',
      severity: 'warning',
      condition: 'Maintain audit trail for all data operations',
      guardrailTier: 'local',
    },
  ],
};

// =============================================================================
// ON_FAIL ACTION SELECTION BY ROLE
// =============================================================================

const ON_FAIL_BY_ROLE: Record<
  string,
  { primary: ConstraintAction['type']; secondary?: ConstraintAction['type'] }
> = {
  customer_facing: { primary: 'respond', secondary: 'escalate' },
  internal: { primary: 'block', secondary: 'redact' },
  supervisor: { primary: 'handoff', secondary: 'goto_step' },
};

// =============================================================================
// MAIN ENTRY
// =============================================================================

export function generateConstraints(input: ConstraintGenerationInput): GeneratedConstraint[] {
  const constraints: GeneratedConstraint[] = [];
  const seenConditions = new Set<string>();

  for (const regulation of input.regulations) {
    const templates = REGULATION_TEMPLATES[regulation];
    if (!templates) continue;

    for (const template of templates) {
      // Check if this template applies to any of the agent's sensitivity categories
      const applies = template.sensitivity.some((s) => input.sensitivity.includes(s));
      if (!applies) continue;

      // Dedup: skip if same condition already generated (from overlapping regulations)
      if (seenConditions.has(template.condition)) continue;
      seenConditions.add(template.condition);

      const roleActions = ON_FAIL_BY_ROLE[input.agentRole] ?? ON_FAIL_BY_ROLE.customer_facing;

      const constraint: GeneratedConstraint = {
        condition: template.condition,
        on_fail: {
          type: roleActions.primary,
          message: buildOnFailMessage(template.pattern, input.agentRole),
        },
        severity: template.severity,
        kind: template.kind,
        ...(template.checkpoint ? { checkpoint: template.checkpoint } : {}),
      };

      constraints.push(constraint);
    }
  }

  return constraints;
}

function buildOnFailMessage(pattern: string, role: string): string {
  if (role === 'customer_facing') {
    return `I've detected a compliance issue (${pattern}). Let me handle this safely for you.`;
  }
  if (role === 'internal') {
    return `Blocked: ${pattern} violation detected. Operation halted.`;
  }
  return `Routing to appropriate handler for ${pattern} compliance.`;
}
