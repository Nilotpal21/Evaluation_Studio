# Mock Data — Shapes and Sample Rows

All mock data lives in `lib/mock-data/*.ts`. One file per domain. Every screen references this file via `import { ... } from '@/lib/mock-data/...'`. Sample rows below are starter content — feel free to add more for richer visuals, but keep names and IDs stable across files so cross-references resolve.

## Tenant / identity

```ts
// lib/mock-data/tenant.ts
export const tenant = {
  id: 'cu_cornerstone',
  name: 'Cornerstone Federal Credit Union',
  shortName: 'Cornerstone',
  region: 'us-east',
  charter: 'federal',
  assetsUSD: 2_400_000_000,
};

export const personas = {
  processOwner: {
    id: 'u_np',
    name: 'Nilotpal Prakash',
    email: 'demo@cornerstone.cu',
    role: 'Process Owner',
    initials: 'NP',
    avatarHue: 'purple',
  },
  reviewer: {
    id: 'u_rs',
    name: 'Rina Salgado',
    email: 'rina.salgado@cornerstone.cu',
    role: 'Compliance Reviewer',
    initials: 'RS',
    avatarHue: 'success',
  },
  admin: {
    id: 'u_jc',
    name: 'Jordan Chen',
    email: 'jordan.chen@cornerstone.cu',
    role: 'Credit Union Admin',
    initials: 'JC',
    avatarHue: 'info',
  },
};
```

## SOPs

```ts
// lib/mock-data/sops.ts
export type SOPStatus = 'parsed' | 'parsing' | 'failed' | 'archived';

export interface SOP {
  id: string;
  name: string;
  filename: string;
  fileSizeKB: number;
  pages: number;
  uploadedBy: string;            // persona id
  uploadedAt: string;            // ISO date
  status: SOPStatus;
  version: number;
  intentsDetected: number;
  tasksDetected: number;
  escalationsDetected: number;
  blockerFlags: number;
  warningFlags: number;
  suggestionFlags: number;
  appsGenerated: string[];       // App ids
}

export const sops: SOP[] = [
  {
    id: 'sop_card_disputes',
    name: 'Card Dispute Resolution SOP',
    filename: 'Card_Disputes_v3.2.pdf',
    fileSizeKB: 482,
    pages: 14,
    uploadedBy: 'u_np',
    uploadedAt: '2026-05-21',
    status: 'parsed',
    version: 3,
    intentsDetected: 9,
    tasksDetected: 12,
    escalationsDetected: 4,
    blockerFlags: 0,
    warningFlags: 2,
    suggestionFlags: 5,
    appsGenerated: ['app_card_dispute_triage'],
  },
  {
    id: 'sop_hardship',
    name: 'Member Hardship Payment Plans',
    filename: 'Hardship_Plans_2026.docx',
    fileSizeKB: 286,
    pages: 9,
    uploadedBy: 'u_np',
    uploadedAt: '2026-05-19',
    status: 'parsed',
    version: 1,
    intentsDetected: 6,
    tasksDetected: 8,
    escalationsDetected: 3,
    blockerFlags: 1,
    warningFlags: 3,
    suggestionFlags: 2,
    appsGenerated: ['app_hardship_assist'],
  },
  {
    id: 'sop_acct_opening',
    name: 'Member Account Opening',
    filename: 'AOS_Onboarding.pdf',
    fileSizeKB: 612,
    pages: 22,
    uploadedBy: 'u_np',
    uploadedAt: '2026-05-15',
    status: 'parsed',
    version: 2,
    intentsDetected: 11,
    tasksDetected: 18,
    escalationsDetected: 6,
    blockerFlags: 0,
    warningFlags: 1,
    suggestionFlags: 8,
    appsGenerated: ['app_account_opening'],
  },
  {
    id: 'sop_fraud_triage',
    name: 'Fraud Triage and Member Notification',
    filename: 'Fraud_Triage_v1.1.pdf',
    fileSizeKB: 388,
    pages: 11,
    uploadedBy: 'u_np',
    uploadedAt: '2026-05-12',
    status: 'parsed',
    version: 1,
    intentsDetected: 7,
    tasksDetected: 10,
    escalationsDetected: 5,
    blockerFlags: 0,
    warningFlags: 2,
    suggestionFlags: 4,
    appsGenerated: ['app_fraud_triage'],
  },
];
```

## Apps (generated from SOPs)

```ts
// lib/mock-data/apps.ts
export type AppStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'deployed'
  | 'paused';

export type Channel = 'digital' | 'voice' | 'sms' | 'email';

export interface App {
  id: string;
  name: string;
  sopId: string;
  description: string;
  status: AppStatus;
  channels: Channel[];
  subAgents: string[];           // sub-agent ids
  evaluationScore: number;       // 0-100
  evaluationTrend: 'up' | 'flat' | 'down';
  approvalsRequired: number;
  approvalsCompleted: number;
  conversations24h: number;
  tasksCompleted24h: number;
  escalations24h: number;
  guardrailTriggers24h: number;
  deployedAt: string | null;
  deployedVersion: number;
  lastEvaluatedAt: string;
  ownerInitials: string;
}

export const apps: App[] = [
  {
    id: 'app_card_dispute_triage',
    name: 'card-dispute-triage',
    sopId: 'sop_card_disputes',
    description: 'Triages inbound card-dispute inquiries, verifies member identity, and opens a Reg E case with the correct disclosure path.',
    status: 'deployed',
    channels: ['digital', 'voice'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_compliance'],
    evaluationScore: 94,
    evaluationTrend: 'up',
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 1240,
    tasksCompleted24h: 1102,
    escalations24h: 38,
    guardrailTriggers24h: 4,
    deployedAt: '2026-05-22',
    deployedVersion: 3,
    lastEvaluatedAt: '2026-05-27T08:00:00Z',
    ownerInitials: 'NP',
  },
  {
    id: 'app_hardship_assist',
    name: 'hardship-assist',
    sopId: 'sop_hardship',
    description: 'Walks members through hardship eligibility, captures inputs, drafts the payment-plan task for back-office approval.',
    status: 'in_review',
    channels: ['digital'],
    subAgents: ['sa_member_auth', 'sa_collections', 'sa_financial_wellness'],
    evaluationScore: 88,
    evaluationTrend: 'flat',
    approvalsRequired: 2,
    approvalsCompleted: 1,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '2026-05-26T18:00:00Z',
    ownerInitials: 'NP',
  },
  {
    id: 'app_account_opening',
    name: 'account-opening-assistant',
    sopId: 'sop_acct_opening',
    description: 'New-member account opening flow: identity verification, product selection, disclosure delivery, task creation.',
    status: 'deployed',
    channels: ['digital', 'sms'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_knowledge'],
    evaluationScore: 91,
    evaluationTrend: 'up',
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 412,
    tasksCompleted24h: 380,
    escalations24h: 18,
    guardrailTriggers24h: 1,
    deployedAt: '2026-05-15',
    deployedVersion: 2,
    lastEvaluatedAt: '2026-05-27T07:00:00Z',
    ownerInitials: 'NP',
  },
  {
    id: 'app_fraud_triage',
    name: 'fraud-triage',
    sopId: 'sop_fraud_triage',
    description: 'Detects suspicious-activity signals from member conversation, runs fraud-scoring sub-agent, escalates to fraud ops with full context.',
    status: 'approved',
    channels: ['digital', 'voice'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_compliance'],
    evaluationScore: 96,
    evaluationTrend: 'up',
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '2026-05-26T20:00:00Z',
    ownerInitials: 'NP',
  },
  {
    id: 'app_loan_intake',
    name: 'loan-application-intake',
    sopId: 'sop_card_disputes', // placeholder cross-ref; can update when more SOPs are added
    description: 'Captures loan-application intent, runs eligibility pre-check, schedules underwriter handoff.',
    status: 'draft',
    channels: ['digital'],
    subAgents: ['sa_loans', 'sa_member_auth'],
    evaluationScore: 79,
    evaluationTrend: 'flat',
    approvalsRequired: 2,
    approvalsCompleted: 0,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '2026-05-25T16:00:00Z',
    ownerInitials: 'NP',
  },
];
```

## Sub-agents (platform-provided library)

```ts
// lib/mock-data/sub-agents.ts
export interface SubAgent {
  id: string;
  name: string;
  domain: string;
  description: string;
  toolsBound: string[];
  knowledgeAttached: string[];
  guardrailsApplied: string[];
}

export const subAgents: SubAgent[] = [
  { id: 'sa_member_auth', name: 'Authentication', domain: 'Identity', description: 'Verifies member identity with multi-factor and KYC checks.', toolsBound: ['tool_idv', 'tool_core_banking'], knowledgeAttached: ['kp_member_auth_policy'], guardrailsApplied: ['gp_no_pii_echo', 'gp_failed_auth_lockout'] },
  { id: 'sa_account_services', name: 'Account Services', domain: 'Operations', description: 'Handles balance, transactions, statements, and standard servicing tasks.', toolsBound: ['tool_core_banking', 'tool_statements'], knowledgeAttached: ['kp_account_disclosures', 'kp_reg_d_e'], guardrailsApplied: ['gp_no_financial_advice'] },
  { id: 'sa_collections', name: 'Collections', domain: 'Servicing', description: 'Manages hardship workflows, payment-plan drafts, promise-to-pay flows.', toolsBound: ['tool_collections_crm', 'tool_payments'], knowledgeAttached: ['kp_hardship_programs', 'kp_collections_compliance'], guardrailsApplied: ['gp_tcpa_outbound', 'gp_no_threats'] },
  { id: 'sa_financial_wellness', name: 'Financial Wellness', domain: 'Member Health', description: 'Offers budgeting, savings, and educational content within CU policy.', toolsBound: ['tool_education_catalog'], knowledgeAttached: ['kp_financial_wellness'], guardrailsApplied: ['gp_no_financial_advice'] },
  { id: 'sa_loans', name: 'Loan & Payments', domain: 'Lending', description: 'Loan intake, eligibility pre-check, payment scheduling, deferment flows.', toolsBound: ['tool_los', 'tool_payments'], knowledgeAttached: ['kp_loan_products'], guardrailsApplied: ['gp_do_not_quote_final_rates'] },
  { id: 'sa_compliance', name: 'Compliance', domain: 'Risk', description: 'Applies regulatory checks: Reg E, Reg D, GLBA disclosures, FFIEC guidance.', toolsBound: [], knowledgeAttached: ['kp_reg_d_e', 'kp_glba', 'kp_ffiec'], guardrailsApplied: ['gp_mandatory_disclosures'] },
  { id: 'sa_knowledge', name: 'Knowledge', domain: 'Retrieval', description: 'Grounds responses in attached knowledge with citation.', toolsBound: ['tool_retrieval'], knowledgeAttached: [], guardrailsApplied: ['gp_citation_required'] },
];
```

## Conversations / activity

```ts
// lib/mock-data/activity.ts
export type EventKind =
  | 'conversation_completed'
  | 'conversation_failed'
  | 'conversation_escalated'
  | 'task_created'
  | 'task_completed'
  | 'guardrail_triggered'
  | 'evaluation_run'
  | 'sop_uploaded'
  | 'helper_action'
  | 'approval_event'
  | 'deployment_event';

export interface ActivityEvent {
  id: string;
  appId: string;
  kind: EventKind;
  summary: string;
  member?: string;       // member id or anonymous
  durationMs?: number;
  agent?: string;        // sub-agent name
  actor?: string;        // 'system' | persona id
  ago: string;           // pre-formatted relative time
  severity?: 'success' | 'warning' | 'error' | 'info';
}

// Provide ~12-20 sample events covering all kinds.
```

## Evaluation reports

```ts
// lib/mock-data/evaluations.ts
export interface EvaluationCategory {
  id: string;
  name: string;
  score: number;        // 0-100
  trend: 'up' | 'flat' | 'down';
  examplesPassed: number;
  examplesFailed: number;
  notes?: string;
}

export interface EvaluationRun {
  id: string;
  appId: string;
  runAt: string;
  trigger: 'manual' | 'auto_on_edit' | 'scheduled' | 'continuous';
  overallScore: number;
  testSources: {
    preBuiltScenarios: { count: number; passed: number };
    sopDerived: { count: number; passed: number };
    userDefined: { count: number; passed: number };
  };
  categories: EvaluationCategory[];
  topFailingExamples: {
    id: string;
    intent: string;
    expected: string;
    actual: string;
    why: string;
  }[];
}

// Provide one EvaluationRun per app, each with 5-8 categories
// (e.g., "Member authentication," "Reg E disclosure," "Escalation timing",
// "Citation accuracy," "Task creation," "Hardship eligibility logic")
// and 3-5 top failing examples.
```

## Knowledge sources

```ts
// lib/mock-data/knowledge.ts
export type KnowledgeMode = 'upload' | 'connector' | 'crawl' | 'authored' | 'api';

export type KnowledgeStatus = 'active' | 'syncing' | 'stale' | 'deprecated' | 'error';

export interface KnowledgeSource {
  id: string;
  name: string;
  mode: KnowledgeMode;
  provider?: string;        // Confluence / SharePoint / Salesforce Knowledge / ...
  documents: number;
  chunks: number;
  lastSyncedAt: string;
  status: KnowledgeStatus;
  tags: string[];           // e.g., 'reg-e', 'pii', 'regulator-only'
  ownerInitials: string;
  appsConsuming: number;
}

// Provide 8-12 mock sources across all modes:
// - Confluence (operating procedures)
// - SharePoint (policy docs)
// - Salesforce Knowledge (member-facing FAQ)
// - Google Drive (training)
// - Web crawl (CU public KB)
// - Uploaded PDF (Reg E playbook)
// - Authored FAQ pack
// - API push (legacy intranet sync)
```

## Model endpoints

```ts
// lib/mock-data/models.ts
export type ModelMode = 'api_key' | 'openai_compatible' | 'declared_contract' | 'platform_default';

export type ModelPurpose =
  | 'routing'
  | 'response_generation'
  | 'helper'
  | 'embedding'
  | 'evaluation_grading';

export type ModelStatus = 'healthy' | 'degraded' | 'down' | 'fallback_active';

export interface ModelEndpoint {
  id: string;
  name: string;
  provider: string;          // OpenAI / Anthropic / Azure OpenAI / AWS Bedrock / Vertex / Custom
  mode: ModelMode;
  region: string;
  modelIdentifier: string;   // e.g., 'gpt-4o' / 'claude-3.7-sonnet' / 'llama-3.1-70b'
  capabilities: ('tool_use' | 'json_mode' | 'vision' | 'long_context')[];
  purposesAssigned: ModelPurpose[];
  latencyMsP95: number;
  costPer1kTokens: number;
  status: ModelStatus;
  lastHealthcheck: string;
}

// Provide 5-7 endpoints showing the variety:
// - Platform default (Anthropic claude-sonnet)
// - Customer Azure OpenAI (gpt-4o in customer's tenant, us-east)
// - Customer AWS Bedrock (claude-3.5 in customer's account, us-east)
// - Self-hosted OpenAI-compatible (llama-3.1-70b-instruct via vLLM)
// - Embedding model (text-embedding-3-large in customer's Azure)
// - Helper-specific (claude-3.7-sonnet via customer's Anthropic key)
// - Grader (Anthropic direct, platform-default)
```

## Approval / reviewer queue

```ts
// lib/mock-data/approvals.ts
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface ApprovalSummary {
  appId: string;
  appName: string;
  submittedBy: string;       // persona id
  submittedAt: string;
  sopName: string;
  evaluationScore: number;
  channels: Channel[];
  blockerFlags: number;
  warningFlags: number;
  helperEdits: number;       // count of Helper-driven edits since last submit
  status: ApprovalDecision;
  reviewers: { personaId: string; decision: ApprovalDecision; at: string | null }[];
}
```

## Marketplace items

```ts
// lib/mock-data/marketplace.ts
export type MarketplaceKind = 'template' | 'sub_agent' | 'knowledge_pack' | 'guardrail_pack' | 'evaluation_pack';

export interface MarketplaceItem {
  id: string;
  name: string;
  kind: MarketplaceKind;
  category: string;          // e.g., 'Card Disputes', 'Fraud', 'Member Services'
  description: string;
  version: string;
  installedByCount: number;  // social proof
  curatedBy: 'Platform Team';
  lastUpdated: string;
  installed: boolean;
}

// Provide 12-20 items across all 5 kinds.
```

## Mission Control metrics

```ts
// lib/mock-data/mission-control.ts
export interface AppMetricsTimeSeries {
  appId: string;
  // 24 hourly buckets, latest last
  conversations: number[];
  successRate: number[];     // percentage points
  latencyMs: number[];       // average per hour
  escalations: number[];
  evaluationScore: number[]; // continuous eval per hour where available
  guardrailTriggers: number[];
}

// Provide a series for each deployed app + an aggregate "all apps" series.
```

## Audit log

```ts
// lib/mock-data/audit.ts
export type AuditCategory =
  | 'sop'
  | 'app'
  | 'approval'
  | 'deployment'
  | 'evaluation'
  | 'helper'
  | 'guardrail'
  | 'knowledge'
  | 'model'
  | 'access';

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;             // persona id or 'system'
  category: AuditCategory;
  action: string;
  target: string;            // human-readable target reference
  summary: string;
  appId?: string;
}

// Provide ~25-40 entries across all categories spanning the last 7 days.
```

## Conversation transcript (for live ops drill-down)

```ts
// lib/mock-data/transcripts.ts
export interface TranscriptTurn {
  speaker: 'member' | 'agent' | 'system';
  agent?: string;            // sub-agent name when speaker === 'agent'
  text: string;
  citations?: { sourceId: string; snippet: string }[];
  toolCall?: { tool: string; args: Record<string, unknown> };
  timestamp: string;
}

export interface Conversation {
  id: string;
  appId: string;
  startedAt: string;
  durationMs: number;
  channel: Channel;
  memberId: string;          // 'anon_xxx' for anonymous
  outcome: 'completed' | 'escalated' | 'failed' | 'task_created';
  turns: TranscriptTurn[];
}
```

## Helper conversation history (mock script)

```ts
// lib/mock-data/helper.ts
export interface HelperTurn {
  role: 'user' | 'helper';
  text: string;
  cite?: { kind: 'sop' | 'doc' | 'eval'; ref: string };
  suggestedAction?: { label: string; preview?: string };
  timestamp: string;
}

export interface HelperConversation {
  id: string;
  contextLabel: string;      // e.g., "Review Studio · card-dispute-triage · Knowledge tab"
  startedAt: string;
  turns: HelperTurn[];
}
```

---

**Volume target.** Provide enough rows per dataset for the UIs to look populated and credible. Avoid leaving any list view with fewer than 4–5 rows unless the empty state is part of the demo.

**Stability.** Once IDs are set, don't rename them — many cross-references depend on them.
