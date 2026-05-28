/**
 * Widget types — Contract 5 (widget-interaction)
 *
 * These types match the `input` field of a `tool_call` SSE event
 * when `toolName` is `ask_user` or `collect_file`.
 */

export interface SelectOption {
  label: string;
  value: string;
}

export interface SingleSelectInput {
  question: string;
  widgetType: 'SingleSelect';
  options: SelectOption[];
  allowCustom: boolean;
  defaultValue?: string;
}

export interface MultiSelectInput {
  question: string;
  widgetType: 'MultiSelect';
  options: SelectOption[];
  minSelect?: number;
  maxSelect?: number;
  allowCustom: boolean;
  defaultValues?: string[];
}

export interface TextInputInput {
  question: string;
  widgetType: 'TextInput';
  placeholder?: string;
  multiline: boolean;
  defaultValue?: string;
}

export interface ConfirmationInput {
  question: string;
  widgetType: 'Confirmation';
  confirmLabel: string;
  denyLabel: string;
}

export interface BlueprintConfirmInput {
  question: string;
  widgetType: 'BlueprintConfirm';
  title: string;
  description?: string;
  options: Array<{
    label: string;
    value: 'generate_draft_topology' | 'refine_concept';
    description?: string;
  }>;
  allowCustom: boolean;
}

export interface TopologyApprovalInput {
  question: string;
  widgetType: 'TopologyApproval';
  title: string;
  description?: string;
  agentCount: number;
  edgeCount: number;
  entryPoint?: string;
  agents: string[];
  topology: Record<string, unknown>;
}

export interface TopologyApprovalAnswer {
  action: 'accept' | 'request_changes' | 'reject';
  notes?: string;
}

export interface TopologyRevisionInput {
  question: string;
  widgetType: 'TopologyRevision';
  title: string;
  description?: string;
  options: Array<{
    label: string;
    value: 'agents' | 'responsibilities' | 'handoffs' | 'pattern';
    description?: string;
  }>;
  minSelect: number;
  maxSelect: number;
  allowCustom: boolean;
  notesPlaceholder?: string;
}

export interface TopologyRevisionAnswer {
  targets: Array<'agents' | 'responsibilities' | 'handoffs' | 'pattern'>;
  notes?: string;
}

export interface GateActionOption {
  value: 'accept' | 'modify' | 'reject';
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
  requiresFeedback?: boolean;
  feedbackPlaceholder?: string;
}

export interface GateRequestInput {
  question: string;
  widgetType: 'GateRequest';
  gateType: string;
  title: string;
  description?: string;
  details?: string[];
  actions: GateActionOption[];
}

export interface GateRequestAnswer {
  action: 'accept' | 'modify' | 'reject';
  feedback?: string;
}

export interface FileUploadInput {
  message: string;
  /**
   * Legacy UI-only discriminator. Real collect_file tool payloads do not
   * include widgetType, so the renderer must treat this as optional.
   */
  widgetType?: 'FileUpload';
  accept?: string[];
  maxFiles?: number;
}

export interface BuildCompleteAgentInfo {
  name: string;
  mode: string;
  agentType: string;
  status: 'compiled' | 'warning' | 'error';
  toolCount: number;
  handoffCount: number;
  quality: {
    guardrails: boolean;
    memory: boolean;
    errorHandlers: boolean;
    constraints: boolean;
    catchAllHandoff: boolean;
  };
  warnings: string[];
  error?: string;
  errors: string[];
}

export interface BuildCompleteInput {
  question: string;
  widgetType: 'BuildComplete';
  agents: BuildCompleteAgentInfo[];
  stats: {
    total: number;
    compiled: number;
    warnings: number;
    errors: number;
    toolCount: number;
    elapsedMs: number;
  };
  projectName?: string;
  options: SelectOption[];
  allowCustom: boolean;
}

export interface SecretInputInput {
  flowId: string;
  field: string;
  label: string;
}

import type { OAuthLaunchInput } from './OAuthLaunch';
import type { IntegrationPlanInput } from './IntegrationPlan';

export type { OAuthLaunchInput, IntegrationPlanInput };

export type AskUserInput =
  | BlueprintConfirmInput
  | TopologyApprovalInput
  | TopologyRevisionInput
  | SingleSelectInput
  | MultiSelectInput
  | TextInputInput
  | ConfirmationInput
  | BuildCompleteInput
  | (OAuthLaunchInput & { widgetType: 'OAuthLaunch' })
  | (IntegrationPlanInput & { widgetType: 'IntegrationPlan' });

export type WidgetInput = AskUserInput | FileUploadInput | SecretInputInput | GateRequestInput;

/**
 * Widget answer payloads — Contract 5: Widget Answer Payload
 */
export type SingleSelectAnswer = string;
export type MultiSelectAnswer = string[];
export type TextInputAnswer = string;
export type ConfirmationAnswer = boolean;
export type BlueprintConfirmAnswer = 'generate_draft_topology' | 'refine_concept';
export interface FileUploadAnswer {
  name: string;
  size: number;
  type: string;
  content: string;
}
