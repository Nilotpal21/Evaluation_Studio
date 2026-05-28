import type { EditorSection } from '@/components/agent-editor/types';

export interface GatherVisualEditorCompatibilityIssue {
  fieldName: string;
  path: string;
  label: string;
  message: string;
}

const SUPPORTED_GATHER_FIELD_KEYS = new Set([
  'name',
  'prompt',
  'type',
  'required',
  'validation',
  'extraction_hints',
  'infer',
  'pii_type',
  'semantics',
  'sensitive',
  'sensitive_display',
  'mask_config',
  'transient',
  'extraction_pattern',
  'extraction_group',
  'enum_values',
]);

const SUPPORTED_VALIDATION_KEYS = new Set(['type', 'rule', 'error_message']);
const SUPPORTED_SEMANTICS_KEYS = new Set([
  'format',
  'components',
  'unit',
  'lookup',
  'convert_to',
  'locale',
  'kore_entity_type',
  'enum_set',
]);

const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  default: 'default value',
  entity_ref: 'entity reference',
  infer_confidence: 'infer confidence',
  infer_confirm: 'infer confirmation',
  depends_on: 'depends_on',
  prompt_mode: 'prompt mode',
  pii_type: 'PII_TYPE',
  voice_config: 'voice config',
  rich_content: 'rich content',
};

function toDisplayLabel(key: string): string {
  return FIELD_LABEL_OVERRIDES[key] ?? key.split('_').join(' ');
}

function pushIssue(
  issues: GatherVisualEditorCompatibilityIssue[],
  fieldName: string,
  path: string,
  label: string,
): void {
  issues.push({
    fieldName,
    path,
    label,
    message: `${fieldName}: ${label} is not preserved by the visual editor yet.`,
  });
}

function analyzeNestedKeys(
  issues: GatherVisualEditorCompatibilityIssue[],
  fieldName: string,
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
    pushIssue(issues, fieldName, `${prefix}.${key}`, `${prefix}.${key}`);
  }
}

export function analyzeGatherVisualEditorCompatibility(
  ir: Record<string, unknown> | null | undefined,
): GatherVisualEditorCompatibilityIssue[] {
  const rawFields = (ir?.gather as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(rawFields)) {
    return [];
  }

  const issues: GatherVisualEditorCompatibilityIssue[] = [];

  for (const field of rawFields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      continue;
    }

    const fieldRecord = field as Record<string, unknown>;
    const fieldName =
      typeof fieldRecord.name === 'string' && fieldRecord.name.length > 0
        ? fieldRecord.name
        : '(unnamed field)';

    for (const key of Object.keys(fieldRecord)) {
      if (!SUPPORTED_GATHER_FIELD_KEYS.has(key)) {
        pushIssue(issues, fieldName, key, toDisplayLabel(key));
      }
    }

    analyzeNestedKeys(
      issues,
      fieldName,
      'validation',
      fieldRecord.validation,
      SUPPORTED_VALIDATION_KEYS,
    );
    analyzeNestedKeys(
      issues,
      fieldName,
      'semantics',
      fieldRecord.semantics,
      SUPPORTED_SEMANTICS_KEYS,
    );
  }

  return issues;
}

export function getGatherVisualEditorSaveBlockReason(
  dirtySections: Iterable<EditorSection>,
  issues: GatherVisualEditorCompatibilityIssue[],
): string | null {
  const dirty = new Set(dirtySections);
  if (dirty.has('definition')) {
    return null;
  }

  if (!dirty.has('gather') || issues.length === 0) {
    return null;
  }

  return 'The visual editor cannot safely save this GATHER definition yet. Open the DSL editor to preserve unsupported gather metadata.';
}
