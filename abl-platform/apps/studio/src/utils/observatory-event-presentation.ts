import type { ExtendedTraceEvent, ExtendedTraceEventType } from '../types';
import { getConfigurationTraceDiagnostic } from './configuration-trace-events';

/** Human-readable labels for internal observatory event type names. */
const EVENT_TYPE_LABELS: Partial<Record<ExtendedTraceEventType, string>> = {
  agent_enter: 'Agent Enter',
  agent_exit: 'Agent Exit',
  agent_response: 'Agent Response',
  agent_error_handled: 'Handled Error',
  llm_call: 'LLM Call',
  tool_call: 'Tool Call',
  tool_call_start: 'Tool Call Start',
  tool_thought: 'Tool Thought',
  attachment_process: 'Attachment Fetch',
  attachment_upload: 'Attachment Ingest',
  attachment_preprocess: 'Attachment Preprocess',
  tool_call_error: 'Tool Error',
  tool_result: 'Tool Result',
  user_message: 'User Message',
  handoff: 'Handoff',
  flow_step_enter: 'Step Enter',
  flow_step_exit: 'Step Exit',
  flow_transition: 'Flow Transition',
  step_thought: 'Step Thought',
  constraint_check: 'Constraint Check',
  constraint_violation: 'Constraint Violation',
  completion_check: 'Completion Check',
  decision: 'Decision',
  error: 'Error',
  warning: 'Warning',
  status_update: 'Status Update',
  status_clear: 'Status Clear',
  guardrail_check: 'Guardrail Check',
  guardrail_violation: 'Guardrail Violation',
  guardrail_warning: 'Guardrail Warning',
  delegate_start: 'Delegate Start',
  delegate_complete: 'Delegate Complete',
  thread_return: 'Thread Return',
  engine_decision: 'Engine Decision',
  handoff_condition_check: 'Handoff Condition',
  entity_extraction: 'Entity Extraction',
  gather_extraction: 'Gather Extraction',
  data_stored: 'Data Stored',
  digression: 'Digression',
  sub_intent: 'Sub-Intent',
  correction: 'Correction',
  session_start: 'Session Start',
  session_end: 'Session End',
  session_ended: 'Session Ended',
  session_resolution: 'Session Resolution',
  session_created: 'Session Created',
  session_updated: 'Session Updated',
  dsl_collect: 'Collect Data',
  dsl_prompt: 'Generate Prompt',
  dsl_respond: 'Send Response',
  dsl_set: 'Set Variable',
  dsl_on_input: 'Process Input',
  dsl_call: 'Call Action',
  voice_session_start: 'Voice Session Start',
  voice_session_end: 'Voice Session End',
  voice_tts: 'Text-to-Speech',
  voice_stt: 'Speech-to-Text',
  voice_turn: 'Voice Turn',
  voice_barge_in: 'Barge-In',
};

function hasObservatoryEventTypeLabel(type: string): type is ExtendedTraceEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_LABELS, type);
}

function truncateSummary(value: string, maxLength = 100): string {
  return value.length > maxLength ? value.substring(0, maxLength) : value;
}

function getAttachmentSummary(
  eventType: 'attachment_process' | 'attachment_upload' | 'attachment_preprocess',
  data: Record<string, unknown> | undefined,
): string {
  const d = data ?? {};
  const filename = typeof d.filename === 'string' ? d.filename : '';
  const stage = typeof d.stage === 'string' ? d.stage : '';
  const attachmentSummary =
    typeof d.attachmentSummary === 'string' ? d.attachmentSummary : undefined;
  const success = typeof d.success === 'boolean' ? (d.success ? 'success' : 'failed') : undefined;

  switch (eventType) {
    case 'attachment_process': {
      const action = stage === 'download' ? 'fetch' : stage || 'fetch';
      const pieces = [action, filename, success].filter(Boolean);
      return truncateSummary(pieces.join(' — '));
    }

    case 'attachment_upload': {
      const attachmentId = typeof d.attachmentId === 'string' ? d.attachmentId : '';
      const pieces = ['ingest', filename || attachmentId, success].filter(Boolean);
      return truncateSummary(pieces.join(' — '));
    }

    case 'attachment_preprocess': {
      const attachmentCount =
        typeof d.attachmentCount === 'number' ? `${d.attachmentCount} attachment` : '';
      const contentBlockCount =
        typeof d.contentBlockCount === 'number' ? `${d.contentBlockCount} blocks` : '';
      const pieces = [attachmentSummary || attachmentCount, contentBlockCount].filter(Boolean);
      return truncateSummary(pieces.join(' — '));
    }
  }
}

export function getObservatoryEventTypeLabel(type: string): string {
  const explicitLabel = hasObservatoryEventTypeLabel(type) ? EVENT_TYPE_LABELS[type] : undefined;
  return explicitLabel ?? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getObservatoryEventSummary(event: ExtendedTraceEvent): string {
  const d = event.data;
  const diagnostic = getConfigurationTraceDiagnostic(event);

  if (diagnostic) {
    return truncateSummary(`${diagnostic.code} — ${diagnostic.message}`);
  }

  if (event.type === 'agent_error_handled') {
    const errorType =
      typeof d?.errorType === 'string' ? d.errorType : typeof d?.type === 'string' ? d.type : '';
    const message = typeof d?.message === 'string' ? d.message : '';
    if (errorType && message) {
      return truncateSummary(`${errorType} — ${message}`);
    }
    return truncateSummary(errorType || message);
  }

  switch (event.type) {
    case 'agent_enter':
      return event.agentName;
    case 'agent_exit':
      return `${event.agentName} — ${d?.result ?? 'completed'}`;
    case 'llm_call':
      return `${d?.model ?? 'unknown'} — ${d?.tokensIn ?? d?.promptTokens ?? '?'} in / ${d?.tokensOut ?? d?.completionTokens ?? '?'} out`;
    case 'tool_call':
      return String(d?.tool ?? d?.toolName ?? 'unknown');
    case 'tool_thought':
      return String(d?.thought ?? d?.reasoning ?? d?.toolName ?? '').substring(0, 100);
    case 'attachment_process':
    case 'attachment_upload':
    case 'attachment_preprocess':
      return getAttachmentSummary(event.type, d);
    case 'tool_call_error':
      return `${d?.toolName ?? d?.tool ?? '?'} — ${String(d?.error ?? 'unknown').substring(0, 80)}`;
    case 'user_message':
      return String(d?.message ?? d?.text ?? d?.input ?? '').substring(0, 100);
    case 'agent_response':
      return String(d?.message ?? d?.text ?? d?.output ?? '').substring(0, 100);
    case 'handoff':
      return `${d?.from ?? d?.fromAgent ?? '?'} → ${d?.to ?? d?.toAgent ?? '?'}`;
    case 'flow_step_enter':
    case 'flow_step_exit':
      return `${d?.stepName ?? '?'}${d?.result ? ` — ${d.result}` : ''}`;
    case 'flow_transition':
      return `${d?.fromStep ?? '?'} → ${d?.toStep ?? '?'}`;
    case 'step_thought':
      return String(d?.summary ?? d?.thought ?? d?.stepName ?? '').substring(0, 100);
    case 'constraint_check':
      return `${d?.constraint ?? d?.name ?? '?'} — ${d?.passed ? 'passed' : 'failed'}`;
    case 'decision':
      return String(d?.decisionKind ?? d?.type ?? '');
    case 'error':
      return String(d?.message ?? d?.error ?? 'unknown').substring(0, 100);
    case 'completion_check':
      return d?.result ? 'complete' : 'not met';
    case 'status_update':
      return String(d?.text ?? d?.operation ?? '').substring(0, 100);
    case 'status_clear':
      return 'cleared';
    case 'guardrail_check':
      return `${d?.guardrailName ?? d?.name ?? '?'} — ${d?.passed ? 'passed' : 'blocked'}`;
    case 'dsl_collect':
      return `Collecting: ${d?.fieldName ?? d?.field ?? d?.stepName ?? ''}`;
    case 'dsl_prompt':
      return String(d?.promptName ?? d?.template ?? '').substring(0, 80);
    case 'dsl_respond':
      return String(d?.rendered ?? d?.message ?? d?.text ?? '').substring(0, 80);
    case 'dsl_set':
      return `${d?.variable ?? d?.key ?? '?'} = ${String(d?.value ?? '').substring(0, 40)}`;
    case 'dsl_call':
      return String(d?.action ?? d?.tool ?? d?.function ?? '');
    case 'dsl_on_input':
      return String(d?.input ?? d?.message ?? '').substring(0, 80);
    default:
      return '';
  }
}
