import type { EditorSection } from '@/components/agent-editor/types';
import { collectUnsupportedVisualToolInvocationPaths } from './visual-tool-invocation-compat';

export interface FlowVisualEditorCompatibilityIssue {
  stepName: string;
  path: string;
  label: string;
  message: string;
}

const SUPPORTED_FLOW_STEP_KEYS = new Set([
  'name',
  'reasoning_zone',
  'respond',
  'call',
  'call_spec',
  'then',
]);
const SUPPORTED_REASONING_ZONE_KEYS = new Set([
  'goal',
  'available_tools',
  'exit_when',
  'max_turns',
]);

const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  actions: 'ACTIONS',
  on_action: 'ON_ACTION',
  on_input: 'ON_INPUT',
  on_result: 'ON_RESULT',
  on_success: 'ON_SUCCESS',
  on_failure: 'ON_FAILURE',
  message_key: 'message key',
  voice_config: 'voice config',
  rich_content: 'rich content',
  call_with: 'CALL WITH',
  call_as: 'CALL AS',
  call_spec: 'CALL_SPEC',
  with: 'WITH',
  as: 'AS',
  tool: 'tool name',
  success_when: 'SUCCESS_WHEN',
  gather: 'GATHER',
  present: 'PRESENT',
  corrections: 'CORRECTIONS',
  complete_when: 'COMPLETE_WHEN',
  set: 'SET',
  clear: 'CLEAR',
  check: 'CHECK',
  digressions: 'DIGRESSIONS',
  sub_intents: 'SUB_INTENTS',
  on_error: 'ON_ERROR',
  human_approval: 'HUMAN_APPROVAL',
  await_attachment: 'AWAIT_ATTACHMENT',
  transform: 'TRANSFORM',
  constraints: 'STEP_CONSTRAINTS',
};

function toDisplayLabel(key: string): string {
  return FIELD_LABEL_OVERRIDES[key] ?? key.split('_').join(' ');
}

function toDisplayPath(path: string): string {
  return path
    .split('.')
    .map((segment) => toDisplayLabel(segment))
    .join('.');
}

function pushIssue(
  issues: FlowVisualEditorCompatibilityIssue[],
  stepName: string,
  path: string,
  label: string,
): void {
  issues.push({
    stepName,
    path,
    label,
    message: `${stepName}: ${label} is not preserved by the visual editor yet.`,
  });
}

function analyzeNestedKeys(
  issues: FlowVisualEditorCompatibilityIssue[],
  stepName: string,
  prefix: string,
  value: unknown,
  supportedKeys: ReadonlySet<string>,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (supportedKeys.has(key)) {
      continue;
    }
    pushIssue(issues, stepName, `${prefix}.${key}`, `${prefix}.${toDisplayLabel(key)}`);
  }
}

export function analyzeFlowVisualEditorCompatibility(
  ir: Record<string, unknown> | null | undefined,
): FlowVisualEditorCompatibilityIssue[] {
  const rawDefinitions = (ir?.flow as { definitions?: unknown } | undefined)?.definitions;
  if (!rawDefinitions || typeof rawDefinitions !== 'object' || Array.isArray(rawDefinitions)) {
    return [];
  }

  const issues: FlowVisualEditorCompatibilityIssue[] = [];

  for (const [stepName, rawStep] of Object.entries(rawDefinitions)) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      continue;
    }

    const stepRecord = rawStep as Record<string, unknown>;

    for (const key of Object.keys(stepRecord)) {
      if (SUPPORTED_FLOW_STEP_KEYS.has(key)) {
        continue;
      }
      pushIssue(issues, stepName, key, toDisplayLabel(key));
    }

    analyzeNestedKeys(
      issues,
      stepName,
      'reasoning_zone',
      stepRecord.reasoning_zone,
      SUPPORTED_REASONING_ZONE_KEYS,
    );

    if (stepRecord.call_spec !== undefined) {
      for (const path of collectUnsupportedVisualToolInvocationPaths(stepRecord.call_spec)) {
        pushIssue(issues, stepName, path, toDisplayPath(path));
      }
    }
  }

  return issues;
}

export function getFlowVisualEditorSaveBlockReason(
  dirtySections: Iterable<EditorSection>,
  issues: FlowVisualEditorCompatibilityIssue[],
): string | null {
  const dirty = new Set(dirtySections);
  if (dirty.has('definition')) {
    return null;
  }

  if (!dirty.has('flow') || issues.length === 0) {
    return null;
  }

  return 'The visual editor cannot safely save this FLOW definition yet. Open the DSL editor to preserve unsupported flow metadata.';
}
