/**
 * Architect Types
 *
 * Type definitions for the architecture analysis and generation tools.
 */

// =============================================================================
// API DESCRIPTION (Input)
// =============================================================================

export interface ApiEndpoint {
  method: string; // GET, POST, PUT, DELETE, etc.
  path: string; // /api/v1/bookings
  description: string; // What this endpoint does
  params?: Record<string, string>; // Parameter name -> type description
  returns?: string; // Return type description
}

export interface ApiDescription {
  name: string; // Service name (e.g., "Booking Service")
  baseUrl?: string; // Optional base URL
  endpoints: ApiEndpoint[];
}

// =============================================================================
// ARCHITECTURE PATTERNS
// =============================================================================

export type ArchitectureTopology = 'single-agent' | 'supervisor' | 'adaptive-network';

// =============================================================================
// GAP REPORT
// =============================================================================

export interface Alternative {
  approach: string; // What to do instead
  tradeoffs: string; // What you lose
  dslPattern: string; // Example ABL snippet
}

export interface Gap {
  requirement: string; // What was requested
  ablLimitation: string; // Why ABL can't do it directly
  alternatives: Alternative[];
  severity: 'minor' | 'moderate' | 'significant';
}

export interface GapReport {
  gaps: Gap[];
  overallCoverage: number; // 0-100%
}

// =============================================================================
// TOOL SPEC
// =============================================================================

export interface ToolParamSpec {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParamSpec[];
  returns: string; // Return type as ABL syntax: {field: type, ...}
}

// =============================================================================
// GATHER FIELD SPEC
// =============================================================================

export interface GatherFieldSpec {
  name: string;
  prompt: string;
  type: string;
  required: boolean;
  validation?: string;
}

// =============================================================================
// CONSTRAINT SPEC
// =============================================================================

export interface ConstraintSpec {
  condition: string;
  onFail: string;
}

// =============================================================================
// GUARDRAIL SPEC
// =============================================================================

export interface GuardrailSpec {
  name: string;
  kind: 'input' | 'output' | 'both';
  check: string;
  action: 'block' | 'warn' | 'redact' | 'escalate';
  message?: string;
}

// =============================================================================
// MEMORY SPEC
// =============================================================================

export interface MemorySpec {
  session: string[];
  persistent: string[];
}

// =============================================================================
// HANDOFF SPEC
// =============================================================================

export interface HandoffSpec {
  to: string;
  when: string;
  priority?: number;
  pass: string[];
  summary: string;
  return: boolean;
  onReturn?: string;
}

// =============================================================================
// DELEGATE SPEC
// =============================================================================

export interface DelegateSpec {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  useResult: string;
  timeout?: string;
  onFailure?: string;
}

// =============================================================================
// FLOW STEP SPEC
// =============================================================================

export interface FlowStepSpec {
  name: string;
  when?: string;
  maxAttempts?: number;
  onExhausted?: string;
  gather?: {
    fields: GatherFieldSpec[];
    prompt?: string;
  };
  call?: string;
  respond?: string;
  then?: string;
  onFail?: string;
}

// =============================================================================
// ESCALATION SPEC
// =============================================================================

export interface EscalationSpec {
  triggers: {
    when: string;
    reason: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    tags?: string[];
  }[];
  contextForHuman: string[];
}

// =============================================================================
// ERROR HANDLER SPEC
// =============================================================================

export interface ErrorHandlerSpec {
  type: string;
  respond: string;
  retry?: number;
  then?: string;
}

// =============================================================================
// AGENT SPEC
// =============================================================================

export interface AgentSpec {
  name: string;
  /** @deprecated MODE removed — execution style derived from flow presence */
  mode?: 'reasoning' | 'scripted';
  language?: string;
  goal: string;
  persona: string;
  limitations: string[];
  tools: ToolSpec[];
  gather: GatherFieldSpec[];
  memory: MemorySpec;
  constraints: ConstraintSpec[];
  guardrails: GuardrailSpec[];
  flow?: {
    steps: string[];
    definitions: Record<string, FlowStepSpec>;
  };
  delegate: DelegateSpec[];
  handoff: HandoffSpec[];
  escalation?: EscalationSpec;
  errorHandlers: ErrorHandlerSpec[];
  onStart?: {
    respond?: string;
    call?: string;
    set?: Record<string, string>;
  };
  complete: {
    when: string;
    respond?: string;
  }[];
}

// =============================================================================
// SUPERVISOR SPEC
// =============================================================================

export interface SupervisorSpec {
  name: string;
  goal: string;
  persona: string;
  limitations: string[];
  memory: MemorySpec;
  handoff: HandoffSpec[];
  escalation?: EscalationSpec;
  errorHandlers: ErrorHandlerSpec[];
  complete: {
    when: string;
    respond?: string;
  }[];
}

// =============================================================================
// ARCHITECTURE SPEC (Main Output of analyze)
// =============================================================================

export interface ArchitectureSpec {
  projectName: string;
  description: string;
  topology: ArchitectureTopology;

  // Single agent (topology === 'single-agent')
  agent?: AgentSpec;

  // Multi-agent supervisor (topology === 'supervisor')
  supervisor?: SupervisorSpec;
  agents?: AgentSpec[];

  // Adaptive network (topology === 'adaptive-network')
  entryAgent?: string; // Name of entry point agent
  networkAgents?: AgentSpec[];

  // Shared
  gapReport: GapReport;
}

// =============================================================================
// ANALYZE INPUT
// =============================================================================

export interface AnalyzeInput {
  useCase: string;
  existingApis?: ApiDescription[];
  constraints?: string;
}

// =============================================================================
// GENERATE INPUT
// =============================================================================

export interface GenerateInput {
  spec: ArchitectureSpec;
  outputDir: string;
}

// =============================================================================
// GENERATE RESULT
// =============================================================================

export interface GenerateResult {
  projectDir: string;
  filesCreated: string[];
  summary: string;
}
