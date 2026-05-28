import type { EditorSection } from '@/components/agent-editor/types';
import { collectUnsupportedVisualToolInvocationPaths } from './visual-tool-invocation-compat';

type LifecycleSurface = 'onStart' | 'errorHandling' | 'completion';

export interface LifecycleVisualEditorCompatibilityIssue {
  surface: LifecycleSurface;
  path: string;
  label: string;
  message: string;
}

const SUPPORTED_ON_START_KEYS = new Set(['respond', 'call', 'call_spec', 'set']);
const SUPPORTED_ERROR_HANDLING_KEYS = new Set(['handlers', 'default_handler']);
const SUPPORTED_ERROR_HANDLER_KEYS = new Set([
  'type',
  'subtypes',
  'respond',
  'then',
  'handoff_target',
  'retry',
  'retry_delay_ms',
  'retry_backoff',
  'retry_max_delay_ms',
  'backtrack_to',
  'voice_config',
  'rich_content',
  'actions',
]);
const SUPPORTED_COMPLETION_KEYS = new Set(['conditions']);
const SUPPORTED_COMPLETION_CONDITION_KEYS = new Set([
  'when',
  'respond',
  'voice_config',
  'rich_content',
  'actions',
  'store',
]);

const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  call_spec: 'CALL_SPEC',
  with: 'WITH',
  as: 'AS',
  tool: 'tool name',
  voice_config: 'voice config',
  rich_content: 'rich content',
  default_handler: 'default handler',
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
  issues: LifecycleVisualEditorCompatibilityIssue[],
  surface: LifecycleSurface,
  path: string,
  label: string,
): void {
  issues.push({
    surface,
    path,
    label,
    message: `${label} is not preserved by the visual editor yet.`,
  });
}

function analyzeKeys(
  issues: LifecycleVisualEditorCompatibilityIssue[],
  surface: LifecycleSurface,
  record: Record<string, unknown>,
  supportedKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (supportedKeys.has(key)) {
      continue;
    }
    pushIssue(issues, surface, key, toDisplayLabel(key));
  }
}

export function analyzeLifecycleVisualEditorCompatibility(
  ir: Record<string, unknown> | null | undefined,
): LifecycleVisualEditorCompatibilityIssue[] {
  const issues: LifecycleVisualEditorCompatibilityIssue[] = [];

  const rawOnStart = ir?.on_start;
  if (rawOnStart && typeof rawOnStart === 'object' && !Array.isArray(rawOnStart)) {
    const onStartRecord = rawOnStart as Record<string, unknown>;
    analyzeKeys(issues, 'onStart', onStartRecord, SUPPORTED_ON_START_KEYS);
    if (onStartRecord.call_spec !== undefined) {
      for (const path of collectUnsupportedVisualToolInvocationPaths(onStartRecord.call_spec)) {
        pushIssue(issues, 'onStart', path, toDisplayPath(path));
      }
    }
  }

  const rawErrorHandling = ir?.error_handling;
  if (
    rawErrorHandling &&
    typeof rawErrorHandling === 'object' &&
    !Array.isArray(rawErrorHandling)
  ) {
    const errorHandlingRecord = rawErrorHandling as Record<string, unknown>;
    analyzeKeys(issues, 'errorHandling', errorHandlingRecord, SUPPORTED_ERROR_HANDLING_KEYS);

    const handlers = errorHandlingRecord.handlers;
    if (Array.isArray(handlers)) {
      for (const handler of handlers) {
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
          continue;
        }
        analyzeKeys(
          issues,
          'errorHandling',
          handler as Record<string, unknown>,
          SUPPORTED_ERROR_HANDLER_KEYS,
        );
      }
    }

    const defaultHandler = errorHandlingRecord.default_handler;
    if (defaultHandler && typeof defaultHandler === 'object' && !Array.isArray(defaultHandler)) {
      analyzeKeys(
        issues,
        'errorHandling',
        defaultHandler as Record<string, unknown>,
        SUPPORTED_ERROR_HANDLER_KEYS,
      );
    }
  }

  const rawCompletion = ir?.completion;
  if (rawCompletion && typeof rawCompletion === 'object' && !Array.isArray(rawCompletion)) {
    const completionRecord = rawCompletion as Record<string, unknown>;
    analyzeKeys(issues, 'completion', completionRecord, SUPPORTED_COMPLETION_KEYS);

    const conditions = completionRecord.conditions;
    if (Array.isArray(conditions)) {
      for (const condition of conditions) {
        if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
          continue;
        }
        analyzeKeys(
          issues,
          'completion',
          condition as Record<string, unknown>,
          SUPPORTED_COMPLETION_CONDITION_KEYS,
        );
      }
    }
  }

  return issues;
}

export function getLifecycleVisualEditorSaveBlockReason(
  dirtySections: Iterable<EditorSection>,
  issues: LifecycleVisualEditorCompatibilityIssue[],
): string | null {
  const dirty = new Set(dirtySections);
  if (dirty.has('definition')) {
    return null;
  }

  if (dirty.has('onStart') && issues.some((issue) => issue.surface === 'onStart')) {
    return 'The visual editor cannot safely save this ON_START definition yet. Open the DSL editor to preserve unsupported lifecycle metadata.';
  }

  if (dirty.has('errorHandling') && issues.some((issue) => issue.surface === 'errorHandling')) {
    return 'The visual editor cannot safely save this ON_ERROR definition yet. Open the DSL editor to preserve unsupported lifecycle metadata.';
  }

  if (dirty.has('completion') && issues.some((issue) => issue.surface === 'completion')) {
    return 'The visual editor cannot safely save this COMPLETE definition yet. Open the DSL editor to preserve unsupported lifecycle metadata.';
  }

  return null;
}
