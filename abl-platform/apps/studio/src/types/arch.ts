/**
 * Arch AI Assistant Types
 *
 * Type definitions for the Arch AI-guided project lifecycle assistant.
 */

import type { ValidationIssue } from '@agent-platform/arch-ai';

// =============================================================================
// LIFECYCLE
// =============================================================================

export type LifecycleStage = 'ideate' | 'design' | 'build' | 'test' | 'deploy' | 'evolve' | 'edit';

export type OnboardingPhase =
  | 'welcome'
  | 'interview'
  | 'upload'
  | 'generating'
  | 'reveal'
  | 'review'
  | 'create';

export type AgentCreationStatus = 'pending' | 'saving' | 'success' | 'failed' | 'warning';

export interface AgentCreationResult {
  name: string;
  status: AgentCreationStatus;
  error?: string;
  compilationWarnings?: string[];
}

export type ArchMode = 'assisted' | 'pro';

export interface LifecycleStageInfo {
  id: LifecycleStage;
  label: string;
  description: string;
}

export const LIFECYCLE_STAGES: LifecycleStageInfo[] = [
  { id: 'ideate', label: 'Ideate', description: 'Describe the problem' },
  { id: 'design', label: 'Design', description: 'Architect the solution' },
  { id: 'build', label: 'Build', description: 'Implement the agents' },
  { id: 'test', label: 'Test', description: 'Validate the system' },
  { id: 'deploy', label: 'Deploy', description: 'Ship to production' },
  { id: 'evolve', label: 'Evolve', description: 'Iterate and improve' },
];

/** Subset of stages used in the project creation wizard */
export const WIZARD_STAGES: LifecycleStageInfo[] = LIFECYCLE_STAGES.filter(
  (s) => s.id === 'ideate' || s.id === 'design' || s.id === 'build',
);

// =============================================================================
// MESSAGES
// =============================================================================

export type ArchMessageRole = 'arch' | 'user';

export interface ArchMessage {
  id: string;
  role: ArchMessageRole;
  content: string;
  timestamp: string;
  /** Message type — 'error' renders with error styling instead of normal bubble */
  type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
  /** Optional agent name shown above the bubble */
  agentName?: string;
  /** Attached diff for Apply/Reject */
  diff?: ArchDiff;
  /** Attached topology update */
  topology?: TopologyData;
  /** Attached brief updates */
  briefUpdates?: Partial<ProjectBrief>;
  /** Attached code block with language */
  codeBlocks?: { language: string; code: string }[];
  /** Whether this message is still streaming */
  isStreaming?: boolean;
  /** Structured plan data for type='plan' */
  planData?: PlanData;
  /** Structured proposal data for type='proposal' */
  proposalData?: ProposalData;
}

/** A single change entry used in plans and proposals */
export interface PlanChange {
  type: string;
  description: string;
}

/** Data attached to a plan message */
export interface PlanData {
  summary: string;
  changes: PlanChange[];
}

/** Data attached to a proposal message */
export interface ProposalData {
  stage: SpecGenStage;
  data: unknown;
  summary: string;
  changes: PlanChange[];
}

// =============================================================================
// DIFFS
// =============================================================================

export interface ArchDiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNumber?: number;
}

export interface ArchDiff {
  id: string;
  agentId: string;
  agentName: string;
  fileName: string;
  description: string;
  lines: ArchDiffLine[];
  status: 'pending' | 'applied' | 'rejected';
}

// =============================================================================
// SUGGESTIONS
// =============================================================================

export type SuggestionCategory =
  | 'error-handling'
  | 'escalation'
  | 'testing'
  | 'optimization'
  | 'feature'
  | 'security'
  | 'modify'
  | 'health'
  | 'topology'
  | 'trace';

export interface ArchSuggestion {
  id: string;
  label: string;
  description: string;
  category: SuggestionCategory;
  /** The prompt text sent to Arch when this chip is clicked */
  prompt: string;
  /** Icon name from lucide-react */
  icon: string;
}

// =============================================================================
// PROJECT BRIEF
// =============================================================================

export interface ProjectBrief {
  domain: string;
  problemStatement: string;
  useCases: { label: string; enabled: boolean }[];
  targetUsers: string[];
  channels: string[];
  tone: string;
  constraints: string[];
  estimatedAgents: string;
  complexity: 'low' | 'medium' | 'high';
  uploadedFiles: UploadedFile[];
}

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Summary extracted by Arch from the file contents */
  extractedSummary?: string;
}

export const EMPTY_BRIEF: ProjectBrief = {
  domain: '',
  problemStatement: '',
  useCases: [],
  targetUsers: [],
  channels: [],
  tone: '',
  constraints: [],
  estimatedAgents: '',
  complexity: 'medium',
  uploadedFiles: [],
};

// =============================================================================
// TOPOLOGY
// =============================================================================

export type TopologyNodeType = 'supervisor' | 'agent';
export type TopologyEdgeType = 'routing' | 'handoff' | 'delegate' | 'escalation';
export type AgentExecutionMode = 'scripted' | 'reasoning' | 'hybrid';
export type HealthStatus = 'healthy' | 'warning' | 'error';

export interface TopologyNode {
  id: string;
  name: string;
  type: TopologyNodeType;
  isEntry: boolean;
  executionMode: AgentExecutionMode;
  tools: string[];
  gatherFields: string[];
  flowStepCount: number;
  constraintCount: number;
  healthStatus: HealthStatus;
  description?: string;
}

export interface TopologyEdge {
  from: string;
  to: string;
  type: TopologyEdgeType;
  experienceMode?:
    | 'shared_voice_handoff'
    | 'visible_handoff'
    | 'silent_delegate'
    | 'human_escalation';
  condition?: string;
  returns?: boolean;
}

export interface TopologyData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

// =============================================================================
// GENERATED AGENTS
// =============================================================================

export interface GeneratedAgent {
  id: string;
  name: string;
  executionMode: AgentExecutionMode;
  ablContent: string;
  tools: string[];
  gatherFields: string[];
  flowStepCount: number;
}

// =============================================================================
// AGENT SPECIFICATIONS (intermediary between topology and ABL)
// =============================================================================

/** Tool specification — expanded from just a tool name */
export interface AgentToolSpec {
  name: string;
  description: string;
  params: { name: string; type: string; required: boolean; description?: string }[];
  returns: { type: string; description?: string };
}

/** Gather field specification — expanded from just a field name */
export interface AgentGatherFieldSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone';
  required: boolean;
  prompt: string;
  validation?: string;
}

/** Flow step specification — expanded from just a count */
export interface AgentFlowStepSpec {
  name: string;
  description: string;
  actions: string[];
  transitions: { target: string; condition?: string }[];
}

/** Constraint specification — expanded from just a count */
export interface AgentConstraintSpec {
  name: string;
  condition: string;
  onFail: { action: 'warn' | 'block' | 'escalate'; message: string };
}

/** Complete behavioral specification for one agent */
export interface AgentSpec {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  executionMode: AgentExecutionMode;
  persona: string;
  goal: string;
  domain: string;
  tools: AgentToolSpec[];
  gatherFields: AgentGatherFieldSpec[];
  flowSteps: AgentFlowStepSpec[];
  constraints: AgentConstraintSpec[];
  /** For supervisors: routing rules */
  routing?: { agentId: string; condition: string }[];
}

// =============================================================================
// API
// =============================================================================

export interface ArchChatRequest {
  projectId?: string;
  stage: LifecycleStage;
  messages: { role: ArchMessageRole; content: string }[];
  context?: {
    page?: string;
    agentId?: string;
    agentName?: string;
    currentAbl?: string;
    sessionId?: string;
    topology?: string;
    editingStage?: SpecGenStage;
    editPhase?: 'planning' | 'executing';
    generatedSpec?: {
      topology?: string;
      agents?: string;
      openapi?: string;
      mockProject?: string;
    };
    editContext?: ArchEditContext;
  };
}

export interface ArchChatResponse {
  message: string;
  /** Response type — 'error' indicates a configuration or LLM failure */
  type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
  suggestions?: ArchSuggestion[];
  topology?: TopologyData;
  diff?: ArchDiff;
  briefUpdates?: Partial<ProjectBrief>;
  /** Names of tools invoked during the agentic loop (e.g. ["read_agent_dsl", "compile_abl"]) */
  toolsUsed?: string[];
  agents?: GeneratedAgent[];
  openapi?: OpenAPISpec;
  mockProject?: MockProjectBundle;
  /** Plan returned during planning phase */
  plan?: PlanData;
  /** Proposal returned during execution phase (edit stage) */
  proposal?: ProposalData;
}

export interface ArchGenerateRequest {
  projectId?: string;
  type: 'topology' | 'agent_specs' | 'agents' | 'tests' | 'openapi' | 'mock_project';
  brief: ProjectBrief;
  topology?: TopologyData;
  agentSpecs?: AgentSpec[];
  agents?: GeneratedAgent[];
  openapi?: OpenAPISpec;
}

export interface CompletenessAnalysis {
  missingAgents: { name: string; reason: string; priority: 'recommended' | 'optional' }[];
  missingEdges: { from: string; to: string; type: string; reason: string }[];
  warnings: string[];
}

export interface ArchGenerateResponse {
  topology?: TopologyData;
  agentSpecs?: AgentSpec[];
  agents?: GeneratedAgent[];
  completenessAnalysis?: CompletenessAnalysis;
  openapi?: OpenAPISpec;
  mockProject?: MockProjectBundle;
}

// =============================================================================
// CONTEXT
// =============================================================================

export interface ArchContext {
  page: string;
  projectId?: string;
  agentId?: string;
  agentName?: string;
  sessionId?: string;
  currentAbl?: string;
  topology?: string;
}

// =============================================================================
// DEPLOYMENT
// =============================================================================

export type ReadinessCheckStatus = 'pass' | 'warn' | 'fail';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
  suggestion?: string;
}

export interface DeploymentEnvironment {
  name: string;
  version?: string;
  deployedAt?: string;
  activeSessions: number;
}

// =============================================================================
// TEMPLATES
// =============================================================================

export interface ProjectTemplate {
  id: string;
  name: string;
  domain: string;
  description: string;
  icon: string;
  agentCount: number;
  tags: string[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'healthcare',
    name: 'Healthcare',
    domain: 'healthcare',
    description: 'Patient support, appointments, billing, and lab results',
    icon: 'Heart',
    agentCount: 5,
    tags: ['appointments', 'billing', 'lab-results', 'triage'],
  },
  {
    id: 'banking',
    name: 'Banking',
    domain: 'banking',
    description: 'Account management, transfers, balance inquiries, and support',
    icon: 'Landmark',
    agentCount: 4,
    tags: ['accounts', 'transfers', 'balance', 'support'],
  },
  {
    id: 'telecom',
    name: 'Telecom',
    domain: 'telecom',
    description: 'Network operations, troubleshooting, and customer service',
    icon: 'Radio',
    agentCount: 4,
    tags: ['network-ops', 'troubleshooting', 'billing', 'support'],
  },
  {
    id: 'retail',
    name: 'Retail',
    domain: 'retail',
    description: 'Order tracking, returns, product questions, and support',
    icon: 'ShoppingBag',
    agentCount: 4,
    tags: ['orders', 'returns', 'products', 'support'],
  },
  {
    id: 'it-support',
    name: 'IT Support',
    domain: 'it',
    description: 'Help desk, password resets, ticket management, and escalation',
    icon: 'Monitor',
    agentCount: 3,
    tags: ['helpdesk', 'tickets', 'troubleshooting'],
  },
];

// =============================================================================
// SPEC GENERATION TYPES
// =============================================================================

/** Input for the Quick Generate pipeline */
export interface SpecGenInput {
  domain: string;
  problemStatement: string;
  details?: string;
}

/** OpenAPI 3.1 spec — lightweight shape for client-side rendering */
export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface OpenAPIOperation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: { content: Record<string, { schema: unknown; example?: unknown }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: unknown; example?: unknown }> }
  >;
  'x-examples'?: Record<string, unknown>;
}

export interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: { type: string };
  description?: string;
}

/** A file in the mock project bundle */
export interface MockProjectFile {
  path: string;
  content: string;
}

/** Complete Vercel-deployable mock project */
export interface MockProjectBundle {
  projectName: string;
  files: MockProjectFile[];
}

/** Pipeline stage identifier */
export type SpecGenStage = 'topology' | 'agent_specs' | 'agents' | 'openapi' | 'mocks';

/** Pipeline stage status */
export type StageStatus = 'pending' | 'running' | 'complete' | 'error';

/** Entry in the edit history */
export interface EditHistoryEntry {
  stage: SpecGenStage;
  timestamp: string;
  summary: string;
}

/** Stage results accumulator */
export interface SpecGenStageResults {
  topology: TopologyData | null;
  agentSpecs: AgentSpec[] | null;
  agents: GeneratedAgent[] | null;
  openapi: OpenAPISpec | null;
  mockProject: MockProjectBundle | null;
}

/** Deploy result from Vercel */
export interface VercelDeployResult {
  url: string;
  projectName: string;
  deployedAt: string;
}

// =============================================================================
// EDIT CONTEXT
// =============================================================================

export type AgentSectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'BEHAVIOR'
  | 'LIFECYCLE';

export interface ArchEditContext {
  section: AgentSectionId;
  agentId: string;
  currentContent: unknown;
  siblingContext: {
    mode: string;
    goal: string;
    toolNames: string[];
    gatherFieldNames: string[];
    flowStepNames: string[];
  };
}

// =============================================================================
// IN-PROJECT EXPERIENCE TYPES
// =============================================================================

/** Overlay expansion state for in-project mode */
export type OverlayState = 'closed' | 'chat' | 'artifacts' | 'ide';

/** Project summary for Smart Welcome stats card */
export interface ProjectSummary {
  agentCount: number;
  toolCount: number;
  channelCount: number;
  guardrailCount: number;
  agentNames: string[];
  recentActivity?: { sessions24h: number; errors24h: number };
}

/** ABL construct types for card-based diff rendering */
export type ABLConstructType =
  | 'FULL'
  | 'AGENT'
  | 'PERSONA'
  | 'GOAL'
  | 'LIMITATIONS'
  | 'GATHER'
  | 'TOOLS'
  | 'FLOW'
  | 'HANDOFFS'
  | 'CONSTRAINTS'
  | 'GUARDRAILS'
  | 'EXECUTION'
  | 'MEMORY'
  | 'ON_INPUT'
  | 'ON_FAIL'
  | 'RESPOND';

/** Single proposed change for card-based diff */
export interface ProposedChange {
  construct: ABLConstructType;
  /** null if new construct being added */
  before: string | null;
  /** null if construct being removed */
  after: string | null;
  /** "Why" insight explaining the rationale */
  rationale: string;
}

/**
 * Client-side proposal review status — WIDER than the server-persisted
 * union (`PendingMutation.reviewStatus` on the server session model).
 *
 * Server persists: 'pending' | 'blocked'
 *   - 'pending' is the default (implied when undefined)
 *   - 'blocked' is set when the validation repair loop exhausts its budget
 *
 * Client-only transient states (never round-trip to the server):
 *   - 'applying'  → apply_modification mutation in flight
 *   - 'applied'   → mutation succeeded, awaiting session refresh
 *   - 'rejected'  → user clicked Reject locally; the session-side clear is
 *                    handled by the reject route, which resets reviewStatus
 *                    back to 'pending' on the server model
 *
 * Do NOT send these transient states in any payload the server reads — the
 * server Zod schemas will only accept the narrower union.
 */
export type ProposalReviewStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'blocked';

export interface ProposalValidation {
  valid: boolean;
  /** Full ValidationIssue shape preserved — includes optional line, source, and agent. */
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface ModificationProposal {
  agentName: string;
  changes: ProposedChange[];
  compilationStatus?: { success: boolean; errors: string[]; warnings: string[] };
  change?: string;
  currentCode?: string;
  proposedCode?: string;
  linesChanged?: number;
  reviewStatus?: ProposalReviewStatus;
  validation?: ProposalValidation;
  applyError?: string;
}

/** Health check result per agent */
export interface AgentHealthResult {
  agentName: string;
  checks: {
    compilation: 'PASS' | 'WARN' | 'FAIL';
    handoffs: 'PASS' | 'WARN' | 'FAIL';
    toolBindings: 'PASS' | 'WARN' | 'FAIL';
    modelConfig: 'PASS' | 'WARN' | 'FAIL';
    guardrails: 'PASS' | 'WARN' | 'FAIL';
    entryPoint: 'PASS' | 'WARN' | 'FAIL';
  };
  details: Array<{
    check: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    suggestedFix?: string;
  }>;
}

export interface HealthFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  agentName: string | null;
}

export interface HealthScoreSummary {
  percent: number;
  totalAgents: number;
  healthyAgents: number;
  warningAgents: number;
  failingAgents: number;
  totalChecks: number;
  passedChecks: number;
  warningChecks: number;
  failedChecks: number;
  projectErrors: number;
  projectWarnings: number;
  projectInfos: number;
  /** Number of blocking findings (semantic/cross-agent errors + failed agent checks) */
  blockingFindings: number;
  /** True when there are zero blocking findings — safe to deploy */
  deployReady: boolean;
}

/** Full health check report */
export interface HealthCheckReport {
  overall: 'Healthy' | 'Warning' | 'Critical';
  agents: AgentHealthResult[];
  summary: string;
  semanticFindings?: HealthFinding[];
  crossAgentFindings?: HealthFinding[];
  score?: HealthScoreSummary;
}
