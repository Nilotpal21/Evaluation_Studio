/**
 * Event type normalizer and decision kind metadata maps.
 *
 * ClickHouse stores events with dotted type names (e.g. "llm.call.completed").
 * Live WebSocket sessions emit underscore names (e.g. "llm_call").
 * This module normalizes at the ingestion edge so all downstream UI code
 * can use a single vocabulary (underscore names).
 */

import type { LucideIcon } from 'lucide-react';
import { PLATFORM_TO_TRACE_TYPE } from '@agent-platform/observatory';
import {
  ArrowRight,
  Users,
  GitBranch,
  CheckSquare,
  AlertTriangle,
  CheckCircle,
  Shield,
  ShieldAlert,
  FormInput,
  RotateCcw,
  Database,
} from 'lucide-react';

/** Dotted → underscore mapping (applied at ingestion edge) */
const DOTTED_TO_SIMPLE: Readonly<Record<string, string>> = PLATFORM_TO_TRACE_TYPE;

/** Normalize event type — accepts both dotted and underscore forms, returns underscore */
export function normalizeEventType(type: string): string {
  return DOTTED_TO_SIMPLE[type] ?? type;
}

/** Decision kind metadata for UI rendering */
export type DecisionKind =
  | 'handoff'
  | 'delegation'
  | 'flow_transition'
  | 'field_validation'
  | 'escalation'
  | 'completion'
  | 'constraint_check'
  | 'guardrail_check'
  | 'gather_extraction'
  | 'correction'
  | 'data_mutation';

export interface DecisionKindMeta {
  label: string;
  icon: LucideIcon;
  color: string; // tailwind color class
  sections: ('candidates' | 'reasoning' | 'conditions' | 'field' | 'footer')[];
}

export const DECISION_KIND_META: Record<DecisionKind, DecisionKindMeta> = {
  handoff: {
    label: 'Handoff',
    icon: ArrowRight,
    color: 'text-accent',
    sections: ['candidates', 'reasoning'],
  },
  delegation: {
    label: 'Delegation',
    icon: Users,
    color: 'text-info',
    sections: ['candidates', 'reasoning'],
  },
  flow_transition: {
    label: 'Flow Transition',
    icon: GitBranch,
    color: 'text-purple',
    sections: ['reasoning'],
  },
  field_validation: {
    label: 'Field Validation',
    icon: CheckSquare,
    color: 'text-info',
    sections: ['field', 'conditions'],
  },
  escalation: {
    label: 'Escalation',
    icon: AlertTriangle,
    color: 'text-warning',
    sections: ['reasoning'],
  },
  completion: {
    label: 'Completion',
    icon: CheckCircle,
    color: 'text-success',
    sections: ['reasoning'],
  },
  constraint_check: {
    label: 'Constraint',
    icon: Shield,
    color: 'text-warning',
    sections: ['conditions'],
  },
  guardrail_check: {
    label: 'Guardrail',
    icon: ShieldAlert,
    color: 'text-error',
    sections: ['conditions'],
  },
  gather_extraction: {
    label: 'Extraction',
    icon: FormInput,
    color: 'text-info',
    sections: ['field'],
  },
  correction: {
    label: 'Correction',
    icon: RotateCcw,
    color: 'text-warning',
    sections: ['reasoning'],
  },
  data_mutation: {
    label: 'Data Mutation',
    icon: Database,
    color: 'text-muted',
    sections: ['field'],
  },
};
