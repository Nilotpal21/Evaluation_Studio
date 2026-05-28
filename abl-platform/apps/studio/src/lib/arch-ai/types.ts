import type { TopologyData, GeneratedAgent, ProjectBrief } from '@/lib/arch-ai/types/arch';

/** ask_user component types rendered by frontend */
export type AskUserComponentType =
  | 'single_select'
  | 'multi_select'
  | 'text_input'
  | 'confirmation'
  | 'file_upload';

export interface SingleSelectComponent {
  type: 'single_select';
  options: { label: string; description?: string; selected?: boolean }[];
  allowCustom?: boolean;
  allowSkip?: boolean;
  defaultValue?: string;
}

export interface MultiSelectComponent {
  type: 'multi_select';
  options: { label: string; description?: string; selected?: boolean }[];
  min?: number;
  max?: number;
  defaultValues?: string[];
}

export interface TextInputComponent {
  type: 'text_input';
  placeholder?: string;
  multiline?: boolean;
  defaultValue?: string;
}

export interface ConfirmationComponent {
  type: 'confirmation';
  confirmLabel?: string;
  denyLabel?: string;
}

export interface FileUploadComponent {
  type: 'file_upload';
  accept?: string[];
  maxFiles?: number;
}

export type AskUserComponent =
  | SingleSelectComponent
  | MultiSelectComponent
  | TextInputComponent
  | ConfirmationComponent
  | FileUploadComponent;

/** Tool result shapes */
export interface TopologyToolResult {
  topology: TopologyData;
  completeness: {
    missingAgents: { name: string; reason: string; priority: 'recommended' | 'optional' }[];
    missingEdges: { from: string; to: string; type: string; reason: string }[];
    warnings: string[];
  };
  valid: boolean;
  fromStub: boolean;
  stats: { agentCount: number; edgeCount: number; hasEscalation: boolean };
  retryErrors?: string[];
  /** Hint for the LLM on what to do next (e.g., call ask_user for approval) */
  nextAction?: string;
}

export interface AgentToolResult {
  agents: {
    id: string;
    name: string;
    executionMode: string;
    ablContent: string;
    tools: string[];
    gatherFields: string[];
    validation: { valid: boolean; parseErrors: string[]; compileErrors: string[] };
    fromStub: boolean;
  }[];
  allValid: boolean;
  stats: { total: number; valid: number; stubbed: number; failed: number };
  crossValidation?: CrossAgentValidationResult;
}

export interface CreateProjectResult {
  success: boolean;
  projectId: string | null;
  projectName: string;
  results: { agentName: string; status: 'saved' | 'failed'; error?: string }[];
  stats: { total: number; saved: number; failed: number };
}

/** Custom stream event types */
export type ArchAIEvent =
  | { type: 'thinking'; message: string }
  | { type: 'phase_change'; phase: 'collecting' | 'generating' | 'creating' }
  | {
      type: 'tool_progress';
      tool: string;
      agent?: string;
      status: 'started' | 'running' | 'validating' | 'complete' | 'error';
      message?: string;
      durationMs?: number;
    }
  | { type: 'artifact_ready'; artifactType: 'topology' | 'agents'; version: number };

// Re-export commonly used types from arch
export type { TopologyData, GeneratedAgent, ProjectBrief };

// --- Staged Pipeline Types (2026-04-03) ---

export type TopologyPatternId =
  | 'single_agent'
  | 'triage_specialists'
  | 'pipeline'
  | 'hub_spoke'
  | 'mesh';

export type CanonicalEdgeType = 'routing' | 'handoff' | 'delegate' | 'escalation' | 'pipeline_next';

export interface TopologyPattern {
  id: TopologyPatternId;
  name: string;
  whenToUse: string;
  structure: string;
  ablImplications: string;
  edgeTypes: CanonicalEdgeType[];
  antiPatterns: string[];
}

export interface ScoredModel {
  provider: string;
  model: string;
  reason: string;
  costTier?: 'low' | 'medium' | 'high';
  latencyTier?: 'fast' | 'moderate' | 'slow';
}

export interface ModelRecommendation {
  primary: ScoredModel;
  fallback?: ScoredModel;
  perOperation?: Record<string, ScoredModel>;
  executionConfig: {
    temperature: number;
    maxTokens: number;
    compactionPolicy?: string;
  };
  costComparison?: {
    relativeSavings: string;
  };
  tenantFilterUnavailable?: boolean;
}

export interface CompileFixResult {
  success: boolean;
  rounds: number;
  finalAbl: string;
  errors?: Array<{ line?: number; message: string; severity: string }>;
  warnings?: Array<{ line?: number; message: string }>;
  constructsUsed: string[];
}

export interface CrossAgentValidationResult {
  valid: boolean;
  errors: Array<{
    type: string;
    severity: 'error' | 'warning';
    sourceAgent: string;
    targetAgent?: string;
    message: string;
    suggestion?: string;
  }>;
}
