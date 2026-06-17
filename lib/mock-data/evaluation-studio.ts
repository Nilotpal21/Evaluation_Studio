import { apps } from './apps';
import { projectAppMap } from './projects';

export type EvaluationMode = 'pre_prod' | 'prod';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'promoted'
  | 'held'
  | 'rejected'
  | 'warning'
  | 'critical';

export type PromotionDecision = 'promote' | 'hold' | 'reject' | 're_run';
export type BenchmarkOrigin = 'platform_default' | 'project_override';
export type ValidatorKind = 'built_in' | 'custom';
export type ValidatorMethod = 'rule_based' | 'llm_judge' | 'programmatic' | 'hybrid';
export type ValidatorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type HealthState = 'healthy' | 'warning' | 'drift_detected' | 'regression_detected' | 'critical';
export type KillSwitchScope = 'project' | 'agent' | 'version' | 'tool';

export interface AgentVersion {
  id: string;
  appId: string;
  label: string;
  environment: 'pre_prod' | 'prod' | 'candidate';
  releasedAt: string;
  summary: string;
  model: string;
}

export interface EvaluationAgentProfile {
  appId: string;
  projectId: string;
  currentProdVersionId: string | null;
  candidateVersionIds: string[];
  riskLevel: 'low' | 'medium' | 'high';
  domain: string;
}

export interface StageProgress {
  id: string;
  label: string;
  state: 'complete' | 'current' | 'pending';
  note: string;
}

export interface ValidatorOutcome {
  validatorId: string;
  score: number;
  threshold: string;
  origin: BenchmarkOrigin;
  blocking: boolean;
  status: 'pass' | 'warn' | 'fail';
  note: string;
}

export interface TraceFailure {
  id: string;
  title: string;
  summary: string;
  whyItFailed: string;
}

export interface EvaluationRun {
  id: string;
  projectId: string;
  appId: string;
  mode: EvaluationMode;
  versionId?: string;
  durationLabel?: string;
  status: RunStatus;
  decision?: PromotionDecision;
  health?: HealthState;
  startedAt: string;
  finishedAt: string;
  triggeredBy: 'user' | 'schedule' | 'autopilot';
  summary: string;
  stages: StageProgress[];
  validatorOutcomes: ValidatorOutcome[];
  coverageSummary: string;
  topFailures: TraceFailure[];
  compareSummary: string;
  incidentCount: number;
}

export interface ProjectValidator {
  id: string;
  projectId: string;
  name: string;
  kind: ValidatorKind;
  method: ValidatorMethod;
  severity: ValidatorSeverity;
  environments: EvaluationMode[];
  benchmarkOrigin: BenchmarkOrigin;
  benchmarkLabel: string;
  linkedGoldens: string[];
  linkedKnowledgeBases: string[];
  blockingInPreProd: boolean;
  appliesTo: 'all_agents' | string[];
  lastUsed: string;
  description: string;
}

export interface MonitoringIncident {
  id: string;
  projectId: string;
  appId: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  detectedAt: string;
}

export interface ProjectMonitoringSnapshot {
  projectId: string;
  activeAppId: string;
  activeVersionId: string;
  health: HealthState;
  successRate: string;
  p95Latency: string;
  runCost: string;
  toolFailureRate: string;
  policyIncidents: number;
  driftScore: string;
  activeAlerts: number;
}

export interface ControlEvent {
  id: string;
  projectId: string;
  kind: 'revert' | 'kill_switch';
  scope: KillSwitchScope;
  targetLabel: string;
  status: 'available' | 'triggered' | 'completed';
  updatedAt: string;
  note: string;
}

export interface PreProdWorkspaceNavItem {
  id: string;
  label: string;
  section: 'simulations' | 'observability';
}

export interface PreProdSessionRecord {
  id: string;
  traceCount: number;
  createdAt: string;
  duration: string;
  trajectoryCompletion: string;
}

export interface PreProdTraceRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  latency: string;
  agentCallAccuracy: string;
}

export interface TraceTreeNode {
  id: string;
  label: string;
  duration: string;
  cost?: string;
  kind: 'root' | 'agent' | 'tool';
  status?: string;
  expanded?: boolean;
  children?: TraceTreeNode[];
}

export interface TraceEvaluatorCard {
  id: string;
  title: string;
  scoreLabel: string;
  status: 'pass' | 'fail' | 'score';
  body: string;
  expanded?: boolean;
}

export interface PreProdTraceDetail {
  traceId: string;
  header: string;
  duration: string;
  cost: string;
  supervisorAccuracy: string;
  agentToolAccuracy: string;
  tree: TraceTreeNode[];
  supervisorEvaluators: TraceEvaluatorCard[];
  toolEvaluators: TraceEvaluatorCard[];
  inspectors: Array<{
    nodeId: string;
    breadcrumbs: string[];
    title: string;
    status: 'pass' | 'fail' | 'score';
    statusLabel: string;
    summary: string;
    input: string;
    output: string;
  }>;
}

export interface SessionTranscriptTurn {
  id: string;
  speaker: 'persona' | 'agent';
  label: string;
  timestamp: string;
  message: string;
}

export interface PreProdSessionDetail {
  sessionId: string;
  duration: string;
  transcript: SessionTranscriptTurn[];
  evaluationSummary: {
    status: 'Pass' | 'Fail';
    finalGoalAchieved: 'Yes' | 'No';
    narrative: string;
    workflowSteps: Array<{
      id: string;
      label: string;
      status: 'pass' | 'fail';
    }>;
  };
}

export interface PreProdWorkspaceData {
  projectId: string;
  appLabel: string;
  appId: string;
  projectLabel: string;
  evaluationLabel: string;
  sessionRows: PreProdSessionRecord[];
  traceRows: PreProdTraceRecord[];
  sessionDetails: PreProdSessionDetail[];
  traceDetails: PreProdTraceDetail[];
  navItems: PreProdWorkspaceNavItem[];
}

export const agentVersions: AgentVersion[] = [
  {
    id: 'ver_card_v24',
    appId: 'app_card_dispute_triage',
    label: 'v24',
    environment: 'candidate',
    releasedAt: '2026-06-17 09:20',
    summary: 'Refined ambiguous-card routing and clarified payment confirmation prompts.',
    model: 'gpt-5.1',
  },
  {
    id: 'ver_card_v23',
    appId: 'app_card_dispute_triage',
    label: 'v23',
    environment: 'prod',
    releasedAt: '2026-06-10 12:10',
    summary: 'Current production release for card dispute routing.',
    model: 'gpt-5.1',
  },
  {
    id: 'ver_fraud_v11',
    appId: 'app_fraud_triage',
    label: 'v11',
    environment: 'candidate',
    releasedAt: '2026-06-17 08:45',
    summary: 'New fraud-exception handling and stronger escalation bundling.',
    model: 'gpt-5.1-mini',
  },
  {
    id: 'ver_fraud_v10',
    appId: 'app_fraud_triage',
    label: 'v10',
    environment: 'pre_prod',
    releasedAt: '2026-06-11 15:05',
    summary: 'Latest approved pre-prod fraud triage package awaiting promotion.',
    model: 'gpt-5.1-mini',
  },
  {
    id: 'ver_acct_v9',
    appId: 'app_account_opening',
    label: 'v9',
    environment: 'prod',
    releasedAt: '2026-06-09 11:00',
    summary: 'Production account opening release with updated disclosure pack.',
    model: 'gpt-5.1',
  },
  {
    id: 'ver_acct_v10',
    appId: 'app_account_opening',
    label: 'v10',
    environment: 'candidate',
    releasedAt: '2026-06-16 18:10',
    summary: 'Candidate build with improved joint-applicant classification.',
    model: 'gpt-5.1',
  },
  {
    id: 'ver_hardship_v6',
    appId: 'app_hardship_assist',
    label: 'v6',
    environment: 'candidate',
    releasedAt: '2026-06-15 16:00',
    summary: 'Reworked hardship-plan drafting to require evidence collection first.',
    model: 'gpt-5.1-mini',
  },
];

export const evaluationAgentProfiles: EvaluationAgentProfile[] = apps.map((app) => {
  const currentProd =
    app.status === 'deployed' && app.deployedVersion > 0
      ? agentVersions.find((version) => version.appId === app.id && version.environment === 'prod')?.id ?? null
      : null;

  return {
    appId: app.id,
    projectId: projectAppMap[app.id],
    currentProdVersionId: currentProd,
    candidateVersionIds: agentVersions
      .filter((version) => version.appId === app.id && version.environment === 'candidate')
      .map((version) => version.id),
    riskLevel:
      app.id === 'app_card_dispute_triage' || app.id === 'app_fraud_triage'
        ? 'high'
        : app.id === 'app_account_opening'
          ? 'medium'
          : 'low',
    domain:
      app.id === 'app_card_dispute_triage'
        ? 'payments'
        : app.id === 'app_fraud_triage'
          ? 'fraud_ops'
          : app.id === 'app_account_opening'
            ? 'member_onboarding'
            : 'workflow',
  };
});

export const projectValidators: ProjectValidator[] = [
  {
    id: 'val_task_completion',
    projectId: 'proj_card_services',
    name: 'Task completion',
    kind: 'built_in',
    method: 'hybrid',
    severity: 'high',
    environments: ['pre_prod', 'prod'],
    benchmarkOrigin: 'platform_default',
    benchmarkLabel: '>= 94% success',
    linkedGoldens: ['golden_card_payments'],
    linkedKnowledgeBases: ['kb_card_dispute_policy'],
    blockingInPreProd: true,
    appliesTo: 'all_agents',
    lastUsed: '8 min ago',
    description: 'Verifies the agent completes the intended user task end-to-end.',
  },
  {
    id: 'val_routing_correctness',
    projectId: 'proj_card_services',
    name: 'Routing correctness',
    kind: 'built_in',
    method: 'programmatic',
    severity: 'critical',
    environments: ['pre_prod', 'prod'],
    benchmarkOrigin: 'project_override',
    benchmarkLabel: '>= 99.5% for money movement',
    linkedGoldens: ['golden_card_payments'],
    linkedKnowledgeBases: ['kb_card_dispute_policy', 'kb_card_inventory'],
    blockingInPreProd: true,
    appliesTo: 'all_agents',
    lastUsed: '8 min ago',
    description: 'Ensures the correct workflow, card, and downstream path are selected.',
  },
  {
    id: 'val_clarification',
    projectId: 'proj_card_services',
    name: 'Clarification under ambiguity',
    kind: 'custom',
    method: 'rule_based',
    severity: 'high',
    environments: ['pre_prod', 'prod'],
    benchmarkOrigin: 'project_override',
    benchmarkLabel: '100% required when multiple cards match',
    linkedGoldens: ['golden_ambiguous_card_requests'],
    linkedKnowledgeBases: ['kb_card_resolution_playbook'],
    blockingInPreProd: true,
    appliesTo: ['app_card_dispute_triage'],
    lastUsed: '8 min ago',
    description: 'Fails if the agent attempts payment or dispute routing before resolving card ambiguity.',
  },
  {
    id: 'val_groundedness',
    projectId: 'proj_card_services',
    name: 'Groundedness and citation',
    kind: 'built_in',
    method: 'llm_judge',
    severity: 'medium',
    environments: ['pre_prod', 'prod'],
    benchmarkOrigin: 'platform_default',
    benchmarkLabel: '>= 92% grounded responses',
    linkedGoldens: [],
    linkedKnowledgeBases: ['kb_card_dispute_policy'],
    blockingInPreProd: false,
    appliesTo: 'all_agents',
    lastUsed: '14 min ago',
    description: 'Checks whether claims are supported by linked policy and knowledge sources.',
  },
  {
    id: 'val_prod_drift',
    projectId: 'proj_card_services',
    name: 'Production drift',
    kind: 'built_in',
    method: 'hybrid',
    severity: 'high',
    environments: ['prod'],
    benchmarkOrigin: 'platform_default',
    benchmarkLabel: 'drift delta <= 4 points',
    linkedGoldens: [],
    linkedKnowledgeBases: ['kb_card_dispute_policy'],
    blockingInPreProd: false,
    appliesTo: 'all_agents',
    lastUsed: '22 min ago',
    description: 'Compares live behavior against the last safe baseline and flags material drift.',
  },
  {
    id: 'val_account_scope',
    projectId: 'proj_member_onboarding',
    name: 'Joint applicant classification',
    kind: 'custom',
    method: 'hybrid',
    severity: 'medium',
    environments: ['pre_prod'],
    benchmarkOrigin: 'project_override',
    benchmarkLabel: '>= 96% classification accuracy',
    linkedGoldens: ['golden_joint_applicants'],
    linkedKnowledgeBases: ['kb_account_opening_policy'],
    blockingInPreProd: false,
    appliesTo: ['app_account_opening'],
    lastUsed: '1 hr ago',
    description: 'Scores whether joint applications are classified and routed correctly.',
  },
];

export const evaluationRuns: EvaluationRun[] = [
  {
    id: 'run_preprod_card_v24',
    projectId: 'proj_card_services',
    appId: 'app_card_dispute_triage',
    mode: 'pre_prod',
    versionId: 'ver_card_v24',
    status: 'promoted',
    decision: 'promote',
    startedAt: '2026-06-17 09:28',
    finishedAt: '2026-06-17 09:42',
    triggeredBy: 'user',
    summary: 'Candidate version cleared benchmark gates and auto-promoted.',
    stages: [
      { id: 'ingest', label: 'Ingestion', state: 'complete', note: 'Loaded prompts, tools, KB links, and v24 manifest.' },
      { id: 'personas', label: 'Persona inference', state: 'complete', note: 'Synthesized 12 operational personas including ambiguous-card and adversarial users.' },
      { id: 'scenarios', label: 'Scenario generation', state: 'complete', note: 'Expanded to 214 scenarios across happy-path, failure, and policy cases.' },
      { id: 'simulations', label: 'Simulation', state: 'complete', note: 'Ran 4,280 simulated sessions with targeted ambiguity injection.' },
      { id: 'validation', label: 'Validation', state: 'complete', note: 'Applied built-in validators plus 2 project custom validators.' },
      { id: 'benchmark', label: 'Benchmark scoring', state: 'complete', note: 'Resolved platform defaults and project overrides.' },
      { id: 'decision', label: 'Product decision', state: 'complete', note: 'Promotion policy passed with no blocking failures.' },
      { id: 'promotion', label: 'Promotion', state: 'complete', note: 'Promoted v24 over v23 and activated monitoring.' },
    ],
    validatorOutcomes: [
      {
        validatorId: 'val_task_completion',
        score: 97,
        threshold: '>= 94%',
        origin: 'platform_default',
        blocking: true,
        status: 'pass',
        note: 'Task completion improved on refund-routing and payment-clarity cases.',
      },
      {
        validatorId: 'val_routing_correctness',
        score: 100,
        threshold: '>= 99.5%',
        origin: 'project_override',
        blocking: true,
        status: 'pass',
        note: 'No money-movement or card-target misroutes observed in benchmark suite.',
      },
      {
        validatorId: 'val_clarification',
        score: 100,
        threshold: '100%',
        origin: 'project_override',
        blocking: true,
        status: 'pass',
        note: 'Every ambiguous multi-card request triggered an explicit clarification turn.',
      },
      {
        validatorId: 'val_groundedness',
        score: 95,
        threshold: '>= 92%',
        origin: 'platform_default',
        blocking: false,
        status: 'pass',
        note: 'Groundedness remained above target with stronger KB use on disclosure explanations.',
      },
    ],
    coverageSummary: '12 personas · 214 scenarios · 4,280 sessions · 98% intended coverage reached',
    topFailures: [
      {
        id: 'pf_1',
        title: 'Late clarification on expired-card case',
        summary: 'Agent clarified after one unnecessary tool call when user referenced an expired card nickname.',
        whyItFailed: 'Nickname resolution was attempted before the disambiguation rule fired.',
      },
      {
        id: 'pf_2',
        title: 'Verbose policy explanation on debit-card handoff',
        summary: 'Response exceeded ideal length during an escalation explanation.',
        whyItFailed: 'Groundedness passed, but concision dropped below the advisory threshold.',
      },
    ],
    compareSummary: 'v24 outperformed current prod v23 by +3.4 points overall and removed the last blocking ambiguity failure.',
    incidentCount: 0,
  },
  {
    id: 'run_preprod_fraud_v11',
    projectId: 'proj_card_services',
    appId: 'app_fraud_triage',
    mode: 'pre_prod',
    versionId: 'ver_fraud_v11',
    status: 'held',
    decision: 'hold',
    startedAt: '2026-06-17 08:52',
    finishedAt: '2026-06-17 09:05',
    triggeredBy: 'autopilot',
    summary: 'Candidate held pending broader coverage on new fraud-exception behavior.',
    stages: [
      { id: 'ingest', label: 'Ingestion', state: 'complete', note: 'Loaded v11 fraud routing graph and escalation pack.' },
      { id: 'personas', label: 'Persona inference', state: 'complete', note: 'Built 9 fraud and dispute personas from recent production incidents.' },
      { id: 'scenarios', label: 'Scenario generation', state: 'complete', note: 'Generated 144 scenarios including cloned-card and social-engineering variants.' },
      { id: 'simulations', label: 'Simulation', state: 'complete', note: 'Completed 2,160 sessions.' },
      { id: 'validation', label: 'Validation', state: 'complete', note: 'Validated escalation correctness and PII handling.' },
      { id: 'benchmark', label: 'Benchmark scoring', state: 'complete', note: 'One advisory benchmark under target.' },
      { id: 'decision', label: 'Product decision', state: 'complete', note: 'Held for expanded coverage before promotion.' },
      { id: 'promotion', label: 'Promotion', state: 'pending', note: 'Promotion paused by policy.' },
    ],
    validatorOutcomes: [
      {
        validatorId: 'val_task_completion',
        score: 95,
        threshold: '>= 94%',
        origin: 'platform_default',
        blocking: true,
        status: 'pass',
        note: 'Primary fraud-routing tasks passed target.',
      },
      {
        validatorId: 'val_groundedness',
        score: 91,
        threshold: '>= 92%',
        origin: 'platform_default',
        blocking: false,
        status: 'warn',
        note: 'Advisory miss on two new exception-policy explanations.',
      },
    ],
    coverageSummary: '9 personas · 144 scenarios · 2,160 sessions · 91% intended coverage reached',
    topFailures: [
      {
        id: 'pf_3',
        title: 'Missing fraud-exception policy citation',
        summary: 'Escalation note was correct but lacked a citation to the updated fraud exception policy.',
        whyItFailed: 'Latest KB article was linked, but the response composer skipped the citation step.',
      },
    ],
    compareSummary: 'v11 is operationally strong but needs expanded exception coverage before the product will promote it.',
    incidentCount: 0,
  },
  {
    id: 'run_prod_card_7d',
    projectId: 'proj_card_services',
    appId: 'app_card_dispute_triage',
    mode: 'prod',
    versionId: 'ver_card_v23',
    durationLabel: 'Last 7 days',
    status: 'warning',
    health: 'drift_detected',
    startedAt: '2026-06-17 07:00',
    finishedAt: '2026-06-17 07:09',
    triggeredBy: 'schedule',
    summary: 'Production analysis detected a mild drift in clarification behavior after KB updates.',
    stages: [
      { id: 'resolve', label: 'Production resolve', state: 'complete', note: 'Resolved current prod version and last safe baseline.' },
      { id: 'window', label: 'Traffic collection', state: 'complete', note: 'Collected 8,420 production sessions for the last 7 days.' },
      { id: 'validation', label: 'Validation', state: 'complete', note: 'Applied production validator profile including drift checks.' },
      { id: 'benchmark', label: 'Benchmark scoring', state: 'complete', note: 'Compared against baseline and project thresholds.' },
      { id: 'decision', label: 'Health decision', state: 'complete', note: 'Flagged warning-level drift for operator review.' },
    ],
    validatorOutcomes: [
      {
        validatorId: 'val_prod_drift',
        score: 89,
        threshold: 'drift delta <= 4 points',
        origin: 'platform_default',
        blocking: false,
        status: 'warn',
        note: 'Clarification behavior drifted by 5.1 points after the latest KB refresh.',
      },
      {
        validatorId: 'val_routing_correctness',
        score: 99,
        threshold: '>= 99.5%',
        origin: 'project_override',
        blocking: false,
        status: 'warn',
        note: 'One low-confidence store-card reroute was caught and corrected by a downstream confirmation step.',
      },
      {
        validatorId: 'val_groundedness',
        score: 94,
        threshold: '>= 92%',
        origin: 'platform_default',
        blocking: false,
        status: 'pass',
        note: 'Knowledge grounding remained healthy despite updated KB ordering.',
      },
    ],
    coverageSummary: '8,420 live sessions · 3 active validators · 2 drift findings',
    topFailures: [
      {
        id: 'prod_1',
        title: 'Ambiguous card nickname on production call',
        summary: 'Agent initially favored a store-card alias before asking a clarifying question.',
        whyItFailed: 'The alias ranking changed after the latest KB metadata refresh.',
      },
      {
        id: 'prod_2',
        title: 'Longer-than-normal refund explanation',
        summary: 'Answer was correct but 22% longer than baseline on a complex refund request.',
        whyItFailed: 'Fallback citation formatting introduced extra explanation text.',
      },
    ],
    compareSummary: 'Compared with the previous 7-day window, drift is concentrated in clarification timing rather than hard routing errors.',
    incidentCount: 2,
  },
];

export const monitoringIncidents: MonitoringIncident[] = [
  {
    id: 'incident_1',
    projectId: 'proj_card_services',
    appId: 'app_card_dispute_triage',
    severity: 'warning',
    title: 'Clarification drift detected',
    detail: 'Multi-card clarification timing dropped 5.1 points versus the last safe baseline.',
    detectedAt: '11 min ago',
  },
  {
    id: 'incident_2',
    projectId: 'proj_card_services',
    appId: 'app_card_dispute_triage',
    severity: 'info',
    title: 'Latency increase after KB refresh',
    detail: 'p95 latency rose from 3.2s to 3.6s after the latest KB ranking update.',
    detectedAt: '24 min ago',
  },
];

export const monitoringSnapshots: ProjectMonitoringSnapshot[] = [
  {
    projectId: 'proj_card_services',
    activeAppId: 'app_card_dispute_triage',
    activeVersionId: 'ver_card_v24',
    health: 'warning',
    successRate: '96.8%',
    p95Latency: '3.6s',
    runCost: '$482 / 7d',
    toolFailureRate: '0.7%',
    policyIncidents: 0,
    driftScore: '+5.1',
    activeAlerts: 2,
  },
  {
    projectId: 'proj_member_onboarding',
    activeAppId: 'app_account_opening',
    activeVersionId: 'ver_acct_v9',
    health: 'healthy',
    successRate: '97.9%',
    p95Latency: '2.9s',
    runCost: '$219 / 7d',
    toolFailureRate: '0.3%',
    policyIncidents: 0,
    driftScore: '+0.8',
    activeAlerts: 0,
  },
];

export const controlEvents: ControlEvent[] = [
  {
    id: 'ctl_revert_card',
    projectId: 'proj_card_services',
    kind: 'revert',
    scope: 'version',
    targetLabel: 'card-dispute-triage · revert to v23',
    status: 'available',
    updatedAt: 'available now',
    note: 'Last safe production version is v23.',
  },
  {
    id: 'ctl_kill_card',
    projectId: 'proj_card_services',
    kind: 'kill_switch',
    scope: 'agent',
    targetLabel: 'card-dispute-triage',
    status: 'available',
    updatedAt: 'available now',
    note: 'Immediately pauses live traffic for this agent.',
  },
];

export const preProdWorkspaces: PreProdWorkspaceData[] = [
  {
    projectId: 'proj_card_services',
    appLabel: 'Banking agent',
    appId: 'app_card_dispute_triage',
    projectLabel: 'Banking',
    evaluationLabel: 'My evaluation',
    navItems: [
      { id: 'personas', label: 'Personas', section: 'simulations' },
      { id: 'simulations', label: 'Simulations', section: 'simulations' },
      { id: 'evaluators', label: 'Evaluators', section: 'simulations' },
      { id: 'simulated-evaluations', label: 'Simulated evaluations', section: 'simulations' },
      { id: 'session-evaluation', label: 'Session evaluation', section: 'observability' },
    ],
    sessionRows: [
      { id: 'edu ee67889dgjskok-98989'.replaceAll(' ', ''), traceCount: 12, createdAt: '24/02/2025 at 18:26:04', duration: '01m 05s', trajectoryCompletion: '98%' },
      { id: 'sedrff33899dgjskok-98989', traceCount: 7, createdAt: '24/02/2025 at 18:17:56', duration: '03m 34s', trajectoryCompletion: '92%' },
      { id: 'dfddq56788dgjskok-45678', traceCount: 6, createdAt: '24/02/2025 at 17:56:18', duration: '02m 35s', trajectoryCompletion: '81%' },
      { id: 'sedrff67889dgjskok-34567', traceCount: 12, createdAt: '24/02/2025 at 17:56:11', duration: '01m 21s', trajectoryCompletion: '96%' },
      { id: 'sedrff899dgjskok-98989', traceCount: 4, createdAt: '24/02/2025 at 16:44:44', duration: '01m 05s', trajectoryCompletion: '73%' },
      { id: 'eduee67889dgjskok-98979', traceCount: 5, createdAt: '24/02/2025 at 15:56:34', duration: '09m 22s', trajectoryCompletion: '88%' },
      { id: 'dfdddq56788dgjskok-45678', traceCount: 11, createdAt: '24/02/2025 at 14:36:12', duration: '01m 54s', trajectoryCompletion: '90%' },
      { id: 'eduee67889dgjskok-98980', traceCount: 9, createdAt: '24/02/2025 at 14:12:56', duration: '03m 34s', trajectoryCompletion: '84%' },
      { id: 'sedrff33899dgjskok-98981', traceCount: 6, createdAt: '24/02/2025 at 13:56:18', duration: '02m 35s', trajectoryCompletion: '87%' },
      { id: 'dfddq56788dgjskok-45679', traceCount: 3, createdAt: '24/02/2025 at 13:22:11', duration: '01m 21s', trajectoryCompletion: '69%' },
      { id: 'sedrff67889dgjskok-34568', traceCount: 7, createdAt: '24/02/2025 at 12:44:44', duration: '01m 05s', trajectoryCompletion: '93%' },
      { id: 'sedrff899dgjskok-98988', traceCount: 10, createdAt: '24/02/2025 at 11:56:34', duration: '09m 22s', trajectoryCompletion: '90%' },
      { id: 'eduee67889dgjskok-98981', traceCount: 6, createdAt: '24/02/2025 at 11:36:12', duration: '01m 54s', trajectoryCompletion: '82%' },
      { id: 'dfdddq56788dgjskok-45680', traceCount: 8, createdAt: '24/02/2025 at 10:17:56', duration: '03m 34s', trajectoryCompletion: '95%' },
      { id: 'sedrff33899dgjskok-98982', traceCount: 4, createdAt: '24/02/2025 at 09:56:18', duration: '02m 35s', trajectoryCompletion: '77%' },
      { id: 'dfddq56788dgjskok-45681', traceCount: 12, createdAt: '24/02/2025 at 09:26:11', duration: '01m 21s', trajectoryCompletion: '99%' },
      { id: 'sedrff67889dgjskok-34569', traceCount: 5, createdAt: '24/02/2025 at 08:44:44', duration: '01m 05s', trajectoryCompletion: '85%' },
      { id: 'sedrff899dgjskok-98987', traceCount: 7, createdAt: '24/02/2025 at 08:16:34', duration: '04m 12s', trajectoryCompletion: '91%' },
      { id: 'eduee67889dgjskok-98982', traceCount: 9, createdAt: '24/02/2025 at 07:36:12', duration: '02m 14s', trajectoryCompletion: '94%' },
      { id: 'dfdddq56788dgjskok-45682', traceCount: 11, createdAt: '24/02/2025 at 06:58:56', duration: '05m 08s', trajectoryCompletion: '88%' },
    ],
    traceRows: [
      { id: 'eduee67889dgjskok-98989', sessionId: 'eduee67889dgjskok-98989', createdAt: '24/02/2025 at 18:26:04', latency: '01m 05s', agentCallAccuracy: '--' },
      { id: 'sende67889dgjskok-98989', sessionId: 'sedrff33899dgjskok-98989', createdAt: '24/02/2025 at 18:17:56', latency: '03m 34s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98988', sessionId: 'dfddq56788dgjskok-45678', createdAt: '24/02/2025 at 17:56:18', latency: '02m 35s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98987', sessionId: 'sedrff67889dgjskok-34567', createdAt: '24/02/2025 at 17:56:11', latency: '01m 21s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98986', sessionId: 'sedrff899dgjskok-98989', createdAt: '24/02/2025 at 16:44:44', latency: '01m 05s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98985', sessionId: 'eduee67889dgjskok-98989', createdAt: '24/02/2025 at 15:56:34', latency: '09m 22s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98984', sessionId: 'dfdddq56788dgjskok-45678', createdAt: '24/02/2025 at 14:36:12', latency: '01m 54s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98983', sessionId: 'eduee67889dgjskok-98980', createdAt: '24/02/2025 at 14:12:56', latency: '03m 34s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98982', sessionId: 'sedrff33899dgjskok-98981', createdAt: '24/02/2025 at 13:56:18', latency: '02m 35s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98981', sessionId: 'dfddq56788dgjskok-45679', createdAt: '24/02/2025 at 13:22:11', latency: '01m 21s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98980', sessionId: 'sedrff67889dgjskok-34568', createdAt: '24/02/2025 at 12:44:44', latency: '01m 05s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98979', sessionId: 'sedrff899dgjskok-98988', createdAt: '24/02/2025 at 11:56:34', latency: '09m 22s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98978', sessionId: 'eduee67889dgjskok-98981', createdAt: '24/02/2025 at 11:36:12', latency: '01m 54s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98977', sessionId: 'dfdddq56788dgjskok-45680', createdAt: '24/02/2025 at 10:17:56', latency: '03m 34s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98976', sessionId: 'sedrff33899dgjskok-98982', createdAt: '24/02/2025 at 09:56:18', latency: '02m 35s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98975', sessionId: 'dfddq56788dgjskok-45681', createdAt: '24/02/2025 at 09:26:11', latency: '01m 21s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98974', sessionId: 'sedrff67889dgjskok-34569', createdAt: '24/02/2025 at 08:44:44', latency: '01m 05s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98973', sessionId: 'sedrff899dgjskok-98987', createdAt: '24/02/2025 at 08:16:34', latency: '04m 12s', agentCallAccuracy: '10%' },
      { id: 'sende67889dgjskok-98972', sessionId: 'eduee67889dgjskok-98982', createdAt: '24/02/2025 at 07:36:12', latency: '02m 14s', agentCallAccuracy: '40%' },
      { id: 'sende67889dgjskok-98971', sessionId: 'dfdddq56788dgjskok-45682', createdAt: '24/02/2025 at 06:58:56', latency: '05m 08s', agentCallAccuracy: '10%' },
    ],
    sessionDetails: [
      {
        sessionId: 'eduee67889dgjskok-98989',
        duration: '5.81s',
        evaluationSummary: {
          status: 'Pass',
          finalGoalAchieved: 'Yes',
          narrative:
            'The session completed successfully, but the agent gathered account information before validating the transfer destination. That sequencing issue is acceptable for this seeded scenario but still worth tracing.',
          workflowSteps: [
            { id: 'wf_1', label: 'Step 1: Greet the user', status: 'pass' },
            { id: 'wf_2', label: 'Step 2: Clarify the request', status: 'pass' },
            { id: 'wf_3', label: 'Step 3: Confirm payee details', status: 'fail' },
            { id: 'wf_4', label: 'Step 4: Validate transfer amount', status: 'pass' },
            { id: 'wf_5', label: 'Step 5: Tool call', status: 'fail' },
            { id: 'wf_6', label: 'Step 6: End conversation', status: 'pass' },
          ],
        },
        transcript: [
          { id: 't1', speaker: 'persona', label: 'Persona 2', timestamp: '2:32pm', message: 'Can you please transfer my balance?' },
          { id: 't2', speaker: 'agent', label: 'Banking agent', timestamp: '2:32pm', message: 'Yeah sure, to transfer your balance I need the account number first.' },
          { id: 't3', speaker: 'persona', label: 'Persona 2', timestamp: '2:32pm', message: 'Yeah sure it’s 1234567' },
          { id: 't4', speaker: 'agent', label: 'Banking agent', timestamp: '2:32pm', message: 'Thanks for confirming. Can you please get me the payee account number, name and the amount you want to transfer' },
          { id: 't5', speaker: 'persona', label: 'Persona 2', timestamp: '2:32pm', message: 'Yeah sure, Payee name - Alex, account number - 123455666 and I want to transfer $100' },
          { id: 't6', speaker: 'agent', label: 'Banking agent', timestamp: '2:32pm', message: 'Thanks for providing the details! Please confirm you are transferring $100 to Alex with the account number: 123455666' },
          { id: 't7', speaker: 'persona', label: 'Persona 2', timestamp: '2:32pm', message: 'Yes go ahead!' },
          { id: 't8', speaker: 'agent', label: 'Banking agent', timestamp: '2:33pm', message: 'Transfer request captured. This session is marked for evaluation because destination intent was clarified late.' },
        ],
      },
    ],
    traceDetails: [
      {
        traceId: 'eduee67889dgjskok-98989',
        header: 'Netomi trace',
        duration: '5.81s',
        cost: '$0.033205',
        supervisorAccuracy: '50%',
        agentToolAccuracy: '50%',
        tree: [
          {
            id: 'root_1',
            label: 'Supervisor',
            duration: '1.15s',
            cost: '$0.008895',
            kind: 'agent',
            status: '2/2 Passed',
            expanded: true,
            children: [
              {
                id: 'agent_1',
                label: 'Transaction_Manager',
                duration: '1.15s',
                cost: '$0.008895',
                kind: 'agent',
                children: [
                  { id: 'tool_1', label: 'GetBalance', duration: '0.00s', kind: 'tool' },
                  { id: 'tool_2', label: 'TransferFunds', duration: '0.00s', kind: 'tool' },
                ],
              },
              { id: 'tool_3', label: 'AgentCall', duration: '0.00s', kind: 'tool' },
            ],
          },
          {
            id: 'root_2',
            label: 'Supervisor',
            duration: '1.15s',
            cost: '$0.008895',
            kind: 'agent',
            status: '2/2 Passed',
          },
        ],
        supervisorEvaluators: [
          {
            id: 'sv_1',
            title: 'Transaction_Manager',
            scoreLabel: 'Fail',
            status: 'fail',
            body: 'Supervisor selected the transfer manager before confirming whether the member meant debit or credit card routing. Clarification should have happened first.',
          },
          {
            id: 'sv_2',
            title: 'Fund_transfer',
            scoreLabel: 'Pass',
            status: 'pass',
            body: 'Transfer flow stayed within policy. Destination account lookup and amount validation were both completed before the tool call.',
          },
        ],
        toolEvaluators: [
          {
            id: 'tv_1',
            title: 'Transaction_Manager',
            scoreLabel: '50%',
            status: 'score',
            expanded: true,
            body: 'Tool orchestration was partially correct. The agent called the manager in the right stage, but the call lacked the clarified card target expected by the project validator.',
          },
          {
            id: 'tv_2',
            title: 'Check_balance',
            scoreLabel: '50%',
            status: 'score',
            body: 'Balance lookup succeeded, but the result was not used to shape the follow-up response clearly enough for the member.',
          },
        ],
        inspectors: [
          {
            nodeId: 'root_1',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'Supervisor call 1'],
            title: 'Supervisor',
            status: 'score',
            statusLabel: '2/2 Passed',
            summary:
              'Supervisor routed the session into the transfer workflow and completed the seeded run, but one branch still needs tighter clarification before promotion.',
            input:
              'Member asked to transfer a balance, then supplied source account, payee Alex, destination account 123455666, and a transfer amount of $100.',
            output:
              'Supervisor selected Transaction_Manager, collected the transfer details, and flagged the run for clarification-order review before production promotion.',
          },
          {
            nodeId: 'agent_1',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'Transaction_Manager'],
            title: 'Transaction_Manager',
            status: 'fail',
            statusLabel: 'Fail',
            summary:
              'Supervisor selected the transfer manager before confirming whether the member meant debit or credit card routing. Clarification should have happened first.',
            input:
              'Can you please transfer my balance? Member shared account number 1234567 and later provided payee Alex with account number 123455666 for a $100 transfer.',
            output:
              'Transfer request captured, but destination intent was confirmed after the manager selection. Session should be reviewed for clarification-order adherence before promotion.',
          },
          {
            nodeId: 'tool_1',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'Transaction_Manager', 'GetBalance'],
            title: 'GetBalance',
            status: 'pass',
            statusLabel: 'Pass',
            summary:
              'Balance lookup completed successfully and returned the member balance without policy or parameter issues.',
            input:
              'Lookup source account 1234567 before proceeding with the requested transfer.',
            output:
              'Available balance returned. The account could support the proposed $100 transfer.',
          },
          {
            nodeId: 'tool_2',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'Transaction_Manager', 'TransferFunds'],
            title: 'TransferFunds',
            status: 'score',
            statusLabel: '50%',
            summary:
              'Transfer tool call was structurally correct, but the destination intent was locked only after the manager had already been selected.',
            input:
              'Transfer $100 from source account 1234567 to payee Alex at destination account 123455666.',
            output:
              'Transfer request staged successfully. Promotion remains blocked until the clarification step happens before manager selection.',
          },
          {
            nodeId: 'tool_3',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'AgentCall'],
            title: 'AgentCall',
            status: 'score',
            statusLabel: '50%',
            summary:
              'Agent handoff executed in the expected stage, but the context payload did not explicitly preserve the clarified card-routing intent.',
            input:
              'Send the current conversation context and the confirmed transfer details back to the orchestration layer.',
            output:
              'Agent response returned with transfer intent captured, but the call is marked for context-clarity review.',
          },
          {
            nodeId: 'root_2',
            breadcrumbs: ['Netomi trace', 'Supervisor', 'Supervisor call 2'],
            title: 'Supervisor',
            status: 'pass',
            statusLabel: '2/2 Passed',
            summary:
              'Final supervisor pass completed successfully and closed the seeded run with no additional branching errors.',
            input:
              'Review the completed workflow, confirm final session state, and close the run.',
            output:
              'Run finalized. Session is stored for evaluator inspection and promotion benchmarking.',
          },
        ],
      },
    ],
  },
];

export function getEvaluationAgentsForProject(projectId: string, mode: EvaluationMode) {
  return apps.filter((app) => {
    if (projectAppMap[app.id] !== projectId) return false;
    const profile = evaluationAgentProfiles.find((item) => item.appId === app.id);
    if (!profile) return false;
    return mode === 'pre_prod' ? profile.candidateVersionIds.length > 0 : Boolean(profile.currentProdVersionId);
  });
}

export function getAgentVersions(appId: string) {
  return agentVersions.filter((version) => version.appId === appId);
}

export function getVersionById(versionId: string) {
  return agentVersions.find((version) => version.id === versionId);
}

export function getEvaluationRunById(runId: string) {
  return evaluationRuns.find((run) => run.id === runId);
}

export function getProjectRuns(projectId: string) {
  return evaluationRuns.filter((run) => run.projectId === projectId);
}

export function getProjectValidators(projectId: string) {
  return projectValidators.filter((validator) => validator.projectId === projectId);
}

export function getProjectMonitoringSnapshot(projectId: string) {
  return monitoringSnapshots.find((snapshot) => snapshot.projectId === projectId);
}

export function getProjectMonitoringIncidents(projectId: string) {
  return monitoringIncidents.filter((incident) => incident.projectId === projectId);
}

export function getProjectControls(projectId: string) {
  return controlEvents.filter((event) => event.projectId === projectId);
}

export function getPreProdWorkspace(projectId: string) {
  return preProdWorkspaces.find((workspace) => workspace.projectId === projectId);
}
