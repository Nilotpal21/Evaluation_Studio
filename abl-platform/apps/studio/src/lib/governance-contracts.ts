/**
 * Governance type contracts for Studio.
 *
 * These types mirror the runtime governance-contracts.ts shapes. They are
 * maintained as TypeScript interfaces (not Zod schemas) because the runtime
 * schemas depend on VALID_PIPELINE_TYPES from pipeline-analytics-helpers which
 * is runtime-only. If a shared packages/governance-contracts package is
 * created later, replace these with imports from that package.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type RuleOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type RuleSeverity = 'critical' | 'warning' | 'info';
export type PolicyStatus = 'enabled' | 'disabled';
export type RuleStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';
export type AgentOverallStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_EVALUATED';

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export interface GovernancePolicyRule {
  pipelineType: string;
  metric: string;
  operator: RuleOperator;
  threshold: number;
  severity: RuleSeverity;
}

export interface GovernancePolicyItem {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  status: PolicyStatus;
  rules: GovernancePolicyRule[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PoliciesResponse {
  success: boolean;
  data: GovernancePolicyItem[];
}

export interface PolicyResponse {
  success: boolean;
  data: GovernancePolicyItem;
}

export interface CreatePolicyBody {
  name: string;
  description?: string;
  status?: PolicyStatus;
  rules: GovernancePolicyRule[];
}

export interface UpdatePolicyBody {
  name?: string;
  description?: string;
  status?: PolicyStatus;
  rules?: GovernancePolicyRule[];
  version: number;
}

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export interface RuleResult {
  pipelineType: string;
  metric: string;
  status: RuleStatus;
  metricValue: number | null;
  threshold: number;
  severity: RuleSeverity;
}

export interface AgentStatus {
  agentName: string;
  overallStatus: AgentOverallStatus;
  rules: RuleResult[];
}

export interface GovernanceStatusData {
  period: string;
  policies: Array<{ _id: string; name: string; status: string }>;
  agents: AgentStatus[];
  summary: { pass: number; warn: number; fail: number; unavailable: number };
}

export interface StatusResponse {
  success: boolean;
  data: GovernanceStatusData;
}

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

export type AuditEventType = 'breach' | 'recovery';
export type AuditReviewStatus = 'pending' | 'approved' | 'rejected';

export interface AuditEvent {
  eventRef: string;
  timestamp: string;
  pipelineType: string;
  metric: string;
  agentName: string;
  agentVersion?: string;
  threshold: number;
  thresholdAtTime: number;
  actualValue: number;
  severity: RuleSeverity;
  eventType: AuditEventType;
  overrideId?: string;
  reviewStatus?: AuditReviewStatus;
}

export interface AuditResponse {
  success: boolean;
  data: {
    events: AuditEvent[];
    total: number;
    page: number;
    limit: number;
  };
}

export interface CreateOverrideBody {
  justification: string;
  originalSeverity: RuleSeverity;
  policyVersion: number;
}

export interface OverrideResponse {
  success: boolean;
  data: { _id: string };
}

// ---------------------------------------------------------------------------
// Frameworks types
// ---------------------------------------------------------------------------

export type ControlStatus = 'PASS' | 'FAIL' | 'WARN' | 'NOT_EVALUATED';

export interface FrameworkControl {
  controlId: string;
  requirement: string;
  status: ControlStatus;
  evidence: string;
}

export interface FrameworkItem {
  id: 'SOC2' | 'GDPR' | 'EU_AI_ACT';
  label: string;
  controls: FrameworkControl[];
}

export interface FrameworksData {
  frameworks: FrameworkItem[];
}

export interface FrameworksResponse {
  success: boolean;
  data: FrameworksData;
}

// ---------------------------------------------------------------------------
// The 11 pipeline types supported by governance rules
// ---------------------------------------------------------------------------

export const GOVERNANCE_PIPELINE_TYPES = [
  'quality_evaluation',
  'hallucination_detection',
  'guardrail_analysis',
  'drift_detection',
  'context_preservation',
  'knowledge_gap',
  'friction_detection',
  'sentiment_analysis',
  'intent_classification',
  'anomaly_detection',
  'llm_evaluate',
] as const;

export type GovernancePipelineType = (typeof GOVERNANCE_PIPELINE_TYPES)[number];

// Exact ClickHouse column names — must mirror METRIC_REGISTRY in packages/database
export const GOVERNANCE_METRICS: Record<GovernancePipelineType, string[]> = {
  quality_evaluation: ['overall_score', 'helpfulness', 'accuracy'],
  hallucination_detection: ['overall_score', 'faithfulness_score'],
  guardrail_analysis: ['overall_score', 'false_positive_score', 'false_negative_score'],
  drift_detection: ['drift_score'],
  context_preservation: ['overall_score', 'context_score'],
  knowledge_gap: ['overall_score', 'retrieval_precision', 'gap_detected'],
  friction_detection: ['friction_score'],
  sentiment_analysis: ['avg_sentiment'],
  intent_classification: ['confidence'],
  anomaly_detection: ['z_score'],
  llm_evaluate: ['overall_score'],
};
