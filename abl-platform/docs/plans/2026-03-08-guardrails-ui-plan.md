# Guardrails Provider & Policy Creation UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add create/edit/delete UI for guardrail providers and policies with Form/YAML dual-mode editing.

**Architecture:** Wire existing `GuardrailProviderForm` into the config page, create new `GuardrailPolicyForm` with Aporia-style toggle-card rule presets, add shared `GuardrailYamlEditor` (Monaco YAML wrapper) for both forms. All CRUD operations use existing hooks (`useGuardrails.ts`).

**Tech Stack:** React 18, Next.js 15, Monaco Editor (`@monaco-editor/react`), `js-yaml`, Zustand, SWR, Tailwind, Framer Motion, Radix UI Dialog, Lucide icons, `next-intl` i18n.

**Design doc:** `docs/plans/2026-03-08-guardrails-ui-design.md`

---

### Task 1: Add `js-yaml` dependency

**Files:**

- Modify: `apps/studio/package.json`

**Step 1: Install js-yaml**

```bash
cd apps/studio && pnpm add js-yaml && pnpm add -D @types/js-yaml
```

**Step 2: Verify installation**

```bash
cd apps/studio && node -e "require('js-yaml'); console.log('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add apps/studio/package.json pnpm-lock.yaml
git commit -m "chore(studio): add js-yaml dependency for guardrails YAML editor"
```

---

### Task 2: Create `SeveritySelector` component

**Files:**

- Create: `apps/studio/src/components/guardrails/SeveritySelector.tsx`

**Step 1: Create the component**

A 4-button discrete severity selector mapping to threshold values. Uses the AWS/Azure/Lakera pattern of named levels.

```tsx
'use client';

import { clsx } from 'clsx';

export type SeverityLevel = 'safe' | 'low' | 'medium' | 'high';

const SEVERITY_LEVELS: { value: SeverityLevel; label: string; threshold: number }[] = [
  { value: 'safe', label: 'Safe', threshold: 0 },
  { value: 'low', label: 'Low', threshold: 0.3 },
  { value: 'medium', label: 'Med', threshold: 0.5 },
  { value: 'high', label: 'High', threshold: 0.7 },
];

const SEVERITY_COLORS: Record<SeverityLevel, { active: string; inactive: string }> = {
  safe: {
    active: 'bg-success text-success-foreground',
    inactive: 'text-success hover:bg-success-subtle',
  },
  low: {
    active: 'bg-info text-info-foreground',
    inactive: 'text-info hover:bg-info-subtle',
  },
  medium: {
    active: 'bg-warning text-warning-foreground',
    inactive: 'text-warning hover:bg-warning-subtle',
  },
  high: {
    active: 'bg-error text-error-foreground',
    inactive: 'text-error hover:bg-error-subtle',
  },
};

interface SeveritySelectorProps {
  value: SeverityLevel;
  onChange: (level: SeverityLevel) => void;
  disabled?: boolean;
}

export function thresholdToSeverity(threshold: number): SeverityLevel {
  if (threshold >= 0.7) return 'high';
  if (threshold >= 0.5) return 'medium';
  if (threshold >= 0.3) return 'low';
  return 'safe';
}

export function severityToThreshold(level: SeverityLevel): number {
  const found = SEVERITY_LEVELS.find((l) => l.value === level);
  return found?.threshold ?? 0.5;
}

export function SeveritySelector({ value, onChange, disabled }: SeveritySelectorProps) {
  return (
    <div className="flex gap-1">
      {SEVERITY_LEVELS.map((level) => {
        const isActive = value === level.value;
        const colors = SEVERITY_COLORS[level.value];
        return (
          <button
            key={level.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(level.value)}
            className={clsx(
              'px-2.5 py-1 text-xs font-medium rounded-md transition-default',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              isActive ? colors.active : clsx('border border-default', colors.inactive),
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/guardrails/SeveritySelector.tsx
git commit -m "feat(studio): add SeveritySelector component for guardrails"
```

---

### Task 3: Create `GuardrailYamlEditor` component

**Files:**

- Create: `apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx`

**Step 1: Create the Monaco YAML wrapper**

Lightweight Monaco wrapper for YAML editing — no LSP, just syntax highlighting + parse validation.

```tsx
'use client';

import { useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import * as yaml from 'js-yaml';

interface GuardrailYamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

export function GuardrailYamlEditor({
  value,
  onChange,
  height = '400px',
}: GuardrailYamlEditorProps) {
  const [parseError, setParseError] = useState<string | null>(null);

  const handleChange = useCallback(
    (newValue: string | undefined) => {
      const val = newValue ?? '';
      onChange(val);
      try {
        yaml.load(val);
        setParseError(null);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
      }
    },
    [onChange],
  );

  return (
    <div className="space-y-2">
      <div className="rounded-lg overflow-hidden border border-default">
        <Editor
          height={height}
          language="yaml"
          theme="vs-dark"
          value={value}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
      {parseError && <p className="text-xs text-error px-1">YAML parse error: {parseError}</p>}
    </div>
  );
}

/**
 * Serialize a JS object to YAML string for the editor.
 * Strips undefined values and empty strings.
 */
export function toYaml(obj: Record<string, unknown>): string {
  const cleaned = JSON.parse(JSON.stringify(obj));
  return yaml.dump(cleaned, { indent: 2, lineWidth: 120, noRefs: true });
}

/**
 * Parse a YAML string back to a JS object.
 * Returns null if parsing fails.
 */
export function fromYaml(yamlStr: string): Record<string, unknown> | null {
  try {
    const result = yaml.load(yamlStr);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx
git commit -m "feat(studio): add GuardrailYamlEditor Monaco YAML wrapper"
```

---

### Task 4: Create `RuleCard` component

**Files:**

- Create: `apps/studio/src/components/guardrails/RuleCard.tsx`

**Step 1: Create the collapsible toggle rule card**

Each rule card has a toggle (on/off), collapsible body with inline config fields. Supports both preset categories and custom rules.

```tsx
'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import {
  SeveritySelector,
  type SeverityLevel,
  thresholdToSeverity,
  severityToThreshold,
} from './SeveritySelector';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RuleKind = 'input' | 'output' | 'both';
export type RuleAction = 'block' | 'warn' | 'redact' | 'escalate' | 'fix' | 'reask' | 'filter';
export type CheckType = 'cel' | 'provider' | 'llm';

export interface RuleData {
  name: string;
  enabled: boolean;
  kind: RuleKind;
  checkType: CheckType;
  check?: string; // CEL expression (tier 1)
  provider?: string; // Provider name (tier 2)
  category?: string; // Provider category (tier 2)
  llmCheck?: string; // Natural language check (tier 3)
  threshold: number;
  action: RuleAction;
  message?: string;
}

interface RuleCardProps {
  rule: RuleData;
  onChange: (rule: RuleData) => void;
  onRemove?: () => void;
  providerOptions: { value: string; label: string }[];
  isCustom?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KIND_OPTIONS = [
  { value: 'input', label: 'Input' },
  { value: 'output', label: 'Output' },
  { value: 'both', label: 'Both' },
];

const ACTION_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'warn', label: 'Warn' },
  { value: 'redact', label: 'Redact' },
  { value: 'escalate', label: 'Escalate' },
  { value: 'fix', label: 'Fix' },
  { value: 'reask', label: 'Reask' },
  { value: 'filter', label: 'Filter' },
];

const CHECK_TYPE_OPTIONS = [
  { value: 'cel', label: 'CEL Expression' },
  { value: 'provider', label: 'Provider' },
  { value: 'llm', label: 'LLM Check' },
];

const ACTION_BADGE_COLORS: Record<string, string> = {
  block: 'bg-error-subtle text-error',
  warn: 'bg-warning-subtle text-warning',
  redact: 'bg-background-muted text-foreground-muted',
  escalate: 'bg-purple-subtle text-purple',
  fix: 'bg-success-subtle text-success',
  reask: 'bg-info-subtle text-info',
  filter: 'bg-background-muted text-foreground-muted',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function RuleCard({ rule, onChange, onRemove, providerOptions, isCustom }: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const severity = thresholdToSeverity(rule.threshold);

  const handleSeverityChange = (level: SeverityLevel) => {
    onChange({ ...rule, threshold: severityToThreshold(level) });
  };

  const actionColor = ACTION_BADGE_COLORS[rule.action] ?? ACTION_BADGE_COLORS.block;

  return (
    <div
      className={clsx(
        'rounded-xl border bg-background-elevated overflow-hidden transition-default',
        rule.enabled ? 'border-accent/40' : 'border-default',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Toggle
          checked={rule.enabled}
          onChange={(checked) => onChange({ ...rule, enabled: checked })}
        />

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {rule.name || 'Unnamed Rule'}
          </span>
        </button>

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', actionColor)}>
          {rule.action}
        </span>

        {isCustom && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded hover:bg-error-subtle text-muted hover:text-error transition-default"
            aria-label="Remove rule"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Expanded config */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-default space-y-4">
          {isCustom && (
            <Input
              label="Rule Name"
              value={rule.name}
              onChange={(e) => onChange({ ...rule, name: e.target.value })}
              placeholder="e.g. custom_safety_check"
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Applies To"
              options={KIND_OPTIONS}
              value={rule.kind}
              onChange={(e) => onChange({ ...rule, kind: e.target.value as RuleKind })}
            />
            <Select
              label="Action"
              options={ACTION_OPTIONS}
              value={rule.action}
              onChange={(e) => onChange({ ...rule, action: e.target.value as RuleAction })}
            />
          </div>

          {/* Check type — only show selector for custom rules */}
          {isCustom && (
            <Select
              label="Check Type"
              options={CHECK_TYPE_OPTIONS}
              value={rule.checkType}
              onChange={(e) => onChange({ ...rule, checkType: e.target.value as CheckType })}
            />
          )}

          {/* Tier 1: CEL expression */}
          {rule.checkType === 'cel' && (
            <Input
              label="CEL Expression"
              value={rule.check ?? ''}
              onChange={(e) => onChange({ ...rule, check: e.target.value })}
              placeholder='e.g. not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")'
            />
          )}

          {/* Tier 2: Provider */}
          {rule.checkType === 'provider' && (
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Provider"
                options={[{ value: '', label: 'Select provider...' }, ...providerOptions]}
                value={rule.provider ?? ''}
                onChange={(e) => onChange({ ...rule, provider: e.target.value })}
              />
              <Input
                label="Category"
                value={rule.category ?? ''}
                onChange={(e) => onChange({ ...rule, category: e.target.value })}
                placeholder="e.g. hate, pii, violence"
              />
            </div>
          )}

          {/* Tier 3: LLM check */}
          {rule.checkType === 'llm' && (
            <Input
              label="LLM Check"
              value={rule.llmCheck ?? ''}
              onChange={(e) => onChange({ ...rule, llmCheck: e.target.value })}
              placeholder="e.g. Does this message contain instructions for illegal activity?"
            />
          )}

          {/* Severity */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">Severity Threshold</label>
            <SeveritySelector value={severity} onChange={handleSeverityChange} />
          </div>

          {/* Action message */}
          <Input
            label="Action Message"
            value={rule.message ?? ''}
            onChange={(e) => onChange({ ...rule, message: e.target.value })}
            placeholder="Message shown when guardrail triggers"
          />
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/guardrails/RuleCard.tsx
git commit -m "feat(studio): add RuleCard component for guardrail policy rules"
```

---

### Task 5: Add i18n keys for policy form

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add new keys under `admin.guardrails`**

Add the following keys after line 3939 (after `delete_policy_description`), still within the `guardrails` object:

```json
"add_policy": "Add Policy",
"add_policy_title": "Create Guardrail Policy",
"edit_policy_title": "Edit Guardrail Policy",
"policy_form_description": "Define rules and settings for content safety evaluation.",
"policy_name_label": "Policy Name",
"policy_name_placeholder": "e.g. Content Safety Policy",
"policy_description_label": "Description",
"policy_description_placeholder": "What this policy enforces...",
"scope_label": "Scope",
"scope_project": "Project (all agents)",
"scope_agent": "Agent (specific)",
"agent_select_label": "Select Agent",
"agent_select_placeholder": "Choose an agent...",
"rules_title": "Rules",
"rules_description": "Enable and configure guardrail rules. Preset categories have sensible defaults.",
"add_custom_rule": "Add Custom Rule",
"settings_title": "Settings",
"fail_mode_label": "Fail Mode",
"fail_mode_open": "Open (allow on error)",
"fail_mode_closed": "Closed (block on error)",
"timeout_local_label": "Local Timeout (ms)",
"timeout_model_label": "Model Timeout (ms)",
"timeout_llm_label": "LLM Timeout (ms)",
"streaming_label": "Streaming Evaluation",
"streaming_description": "Evaluate guardrails on streamed chunks for lower latency.",
"status_label": "Status",
"status_draft": "Draft",
"status_active": "Active",
"policy_created": "Guardrail policy created",
"policy_updated": "Guardrail policy updated",
"policy_save_failed": "Failed to save guardrail policy",
"create_policy": "Create Policy",
"update_policy": "Update Policy",
"tab_form": "Form",
"tab_yaml": "YAML",
"yaml_parse_error": "YAML parse error",
"preset_content_safety": "Content Safety",
"preset_pii_protection": "PII Protection",
"preset_prompt_injection": "Prompt Injection",
"preset_topic_restriction": "Topic Restriction"
```

Also add to `guardrails_config` section (after line 5761) for the config page buttons:

```json
"add_provider": "Add Provider",
"add_policy": "Add Policy"
```

**Step 2: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add guardrail policy form translation keys"
```

---

### Task 6: Create `GuardrailPolicyForm` component

**Files:**

- Create: `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx`

**Step 1: Create the policy form dialog**

This is the largest component — Form/YAML dual-mode dialog with preset rule categories.

```tsx
'use client';

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { Button } from '../ui/Button';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import { RuleCard, type RuleData } from './RuleCard';
import { GuardrailYamlEditor, toYaml, fromYaml } from './GuardrailYamlEditor';
import { useGuardrailProviders, type GuardrailPolicy } from '../../hooks/useGuardrails';

// ─── Types ───────────────────────────────────────────────────────────────────

type FormTab = 'form' | 'yaml';
type ScopeType = 'project' | 'agent';
type FailMode = 'open' | 'closed';
type PolicyStatus = 'draft' | 'active';

interface GuardrailPolicyFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  initial?: GuardrailPolicy;
  projectId: string;
  agents?: { value: string; label: string }[];
}

// ─── Preset Rules ────────────────────────────────────────────────────────────

function createPresetRules(): RuleData[] {
  return [
    {
      name: 'content_safety',
      enabled: false,
      kind: 'input',
      checkType: 'provider',
      provider: '',
      category: 'hate',
      threshold: 0.5,
      action: 'block',
      message: 'Content blocked for safety violations.',
    },
    {
      name: 'pii_protection',
      enabled: false,
      kind: 'output',
      checkType: 'provider',
      provider: '',
      category: 'pii',
      threshold: 0.3,
      action: 'redact',
      message: 'PII has been redacted from the response.',
    },
    {
      name: 'prompt_injection',
      enabled: false,
      kind: 'input',
      checkType: 'provider',
      provider: '',
      category: 'prompt_injection',
      threshold: 0.7,
      action: 'block',
      message: 'Potential prompt injection detected.',
    },
    {
      name: 'topic_restriction',
      enabled: false,
      kind: 'input',
      checkType: 'llm',
      llmCheck: '',
      threshold: 0.5,
      action: 'warn',
      message: 'This topic is restricted.',
    },
  ];
}

const PRESET_LABELS: Record<string, string> = {
  content_safety: 'Content Safety',
  pii_protection: 'PII Protection',
  prompt_injection: 'Prompt Injection',
  topic_restriction: 'Topic Restriction',
};

// ─── Form State → API Payload ────────────────────────────────────────────────

function buildPayload(
  name: string,
  description: string,
  scopeType: ScopeType,
  agentDefId: string,
  rules: RuleData[],
  customRules: RuleData[],
  failMode: FailMode,
  timeouts: { local: number; model: number; llm: number },
  streaming: boolean,
  status: PolicyStatus,
): Record<string, unknown> {
  const enabledRules = [...rules, ...customRules]
    .filter((r) => r.enabled)
    .map((r) => {
      const rule: Record<string, unknown> = {
        name: r.name,
        kind: r.kind,
        threshold: r.threshold,
        action: { type: r.action, message: r.message || undefined },
      };
      if (r.checkType === 'cel' && r.check) rule.check = r.check;
      if (r.checkType === 'provider' && r.provider) {
        rule.provider = r.provider;
        if (r.category) rule.category = r.category;
      }
      if (r.checkType === 'llm' && r.llmCheck) rule.llmCheck = r.llmCheck;
      return rule;
    });

  const scope: Record<string, unknown> = { type: scopeType };
  if (scopeType === 'agent' && agentDefId) scope.agentDefId = agentDefId;

  return {
    name,
    description: description || undefined,
    scope,
    rules: enabledRules,
    status,
    settings: {
      failMode,
      timeouts,
      streaming: { enabled: streaming },
    },
  };
}

// ─── Form State ↔ YAML ──────────────────────────────────────────────────────

function formToYamlObj(
  name: string,
  description: string,
  scopeType: ScopeType,
  agentDefId: string,
  rules: RuleData[],
  customRules: RuleData[],
  failMode: FailMode,
  timeouts: { local: number; model: number; llm: number },
  streaming: boolean,
  status: PolicyStatus,
): Record<string, unknown> {
  return buildPayload(
    name,
    description,
    scopeType,
    agentDefId,
    rules,
    customRules,
    failMode,
    timeouts,
    streaming,
    status,
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GuardrailPolicyForm({
  open,
  onClose,
  onSubmit,
  initial,
  projectId,
  agents = [],
}: GuardrailPolicyFormProps) {
  const t = useTranslations('admin.guardrails');
  const { providers } = useGuardrailProviders();

  // Tab state
  const [activeTab, setActiveTab] = useState<FormTab>('form');
  const [yamlValue, setYamlValue] = useState('');

  // Basic fields
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  // Scope
  const [scopeType, setScopeType] = useState<ScopeType>(
    initial?.scope?.type === 'agent' ? 'agent' : 'project',
  );
  const [agentDefId, setAgentDefId] = useState(initial?.scope?.agentDefId ?? '');

  // Rules (presets + custom)
  const [presetRules, setPresetRules] = useState<RuleData[]>(() => {
    // If editing, try to map initial rules back to presets
    return createPresetRules();
  });
  const [customRules, setCustomRules] = useState<RuleData[]>([]);

  // Settings
  const [failMode, setFailMode] = useState<FailMode>('closed');
  const [timeoutLocal, setTimeoutLocal] = useState(5000);
  const [timeoutModel, setTimeoutModel] = useState(10000);
  const [timeoutLlm, setTimeoutLlm] = useState(30000);
  const [streaming, setStreaming] = useState(false);

  // Status
  const [status, setStatus] = useState<PolicyStatus>((initial?.status as PolicyStatus) ?? 'draft');

  const [saving, setSaving] = useState(false);

  // Provider options for rule cards
  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.name, label: p.displayName || p.name })),
    [providers],
  );

  // Agent options for scope selector
  const agentOptions = useMemo(
    () => [{ value: '', label: 'Select agent...' }, ...agents],
    [agents],
  );

  // ── Tab switching with bidirectional sync ──

  const switchToYaml = useCallback(() => {
    const obj = formToYamlObj(
      name,
      description,
      scopeType,
      agentDefId,
      presetRules,
      customRules,
      failMode,
      { local: timeoutLocal, model: timeoutModel, llm: timeoutLlm },
      streaming,
      status,
    );
    setYamlValue(toYaml(obj));
    setActiveTab('yaml');
  }, [
    name,
    description,
    scopeType,
    agentDefId,
    presetRules,
    customRules,
    failMode,
    timeoutLocal,
    timeoutModel,
    timeoutLlm,
    streaming,
    status,
  ]);

  const switchToForm = useCallback(() => {
    // Parse YAML back — update name/description/settings if valid
    const parsed = fromYaml(yamlValue);
    if (parsed) {
      if (typeof parsed.name === 'string') setName(parsed.name);
      if (typeof parsed.description === 'string') setDescription(parsed.description);
      if (parsed.status === 'draft' || parsed.status === 'active') setStatus(parsed.status);
      if (parsed.settings && typeof parsed.settings === 'object') {
        const s = parsed.settings as Record<string, unknown>;
        if (s.failMode === 'open' || s.failMode === 'closed') setFailMode(s.failMode);
        if (s.timeouts && typeof s.timeouts === 'object') {
          const to = s.timeouts as Record<string, unknown>;
          if (typeof to.local === 'number') setTimeoutLocal(to.local);
          if (typeof to.model === 'number') setTimeoutModel(to.model);
          if (typeof to.llm === 'number') setTimeoutLlm(to.llm);
        }
      }
    }
    setActiveTab('form');
  }, [yamlValue]);

  // ── Submit ──

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let payload: Record<string, unknown>;
      if (activeTab === 'yaml') {
        const parsed = fromYaml(yamlValue);
        if (!parsed) {
          toast.error('Invalid YAML — please fix parse errors before submitting.');
          setSaving(false);
          return;
        }
        payload = parsed;
      } else {
        payload = buildPayload(
          name,
          description,
          scopeType,
          agentDefId,
          presetRules,
          customRules,
          failMode,
          { local: timeoutLocal, model: timeoutModel, llm: timeoutLlm },
          streaming,
          status,
        );
      }
      await onSubmit(payload);
      toast.success(initial ? t('policy_updated') : t('policy_created'));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('policy_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  // ── Custom rule management ──

  const addCustomRule = () => {
    setCustomRules((prev) => [
      ...prev,
      {
        name: '',
        enabled: true,
        kind: 'input',
        checkType: 'cel',
        check: '',
        threshold: 0.5,
        action: 'block',
        message: '',
      },
    ]);
  };

  const updateCustomRule = (index: number, updated: RuleData) => {
    setCustomRules((prev) => prev.map((r, i) => (i === index ? updated : r)));
  };

  const removeCustomRule = (index: number) => {
    setCustomRules((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl">
      <div className="space-y-5">
        {/* Title */}
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {initial ? t('edit_policy_title') : t('add_policy_title')}
          </h3>
          <p className="text-sm text-muted mt-1">{t('policy_form_description')}</p>
        </div>

        {/* Form / YAML tabs */}
        <div className="flex border-b border-default">
          <button
            type="button"
            onClick={() => (activeTab === 'yaml' ? switchToForm() : undefined)}
            className={clsx(
              'px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px',
              activeTab === 'form'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {t('tab_form')}
          </button>
          <button
            type="button"
            onClick={() => (activeTab === 'form' ? switchToYaml() : undefined)}
            className={clsx(
              'px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px',
              activeTab === 'yaml'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {t('tab_yaml')}
          </button>
        </div>

        {/* YAML editor */}
        {activeTab === 'yaml' && (
          <GuardrailYamlEditor value={yamlValue} onChange={setYamlValue} height="500px" />
        )}

        {/* Form editor */}
        {activeTab === 'form' && (
          <div className="space-y-6">
            {/* Basics */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label={t('policy_name_label')}
                placeholder={t('policy_name_placeholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label={t('policy_description_label')}
                placeholder={t('policy_description_placeholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Scope */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-foreground">
                {t('scope_label')}
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="scope"
                    checked={scopeType === 'project'}
                    onChange={() => setScopeType('project')}
                    className="accent-accent"
                  />
                  {t('scope_project')}
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="scope"
                    checked={scopeType === 'agent'}
                    onChange={() => setScopeType('agent')}
                    className="accent-accent"
                  />
                  {t('scope_agent')}
                </label>
              </div>
              {scopeType === 'agent' && (
                <Select
                  label={t('agent_select_label')}
                  options={agentOptions}
                  value={agentDefId}
                  onChange={(e) => setAgentDefId(e.target.value)}
                />
              )}
            </div>

            {/* Rules — presets */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">{t('rules_title')}</h4>
                  <p className="text-xs text-muted mt-0.5">{t('rules_description')}</p>
                </div>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Plus className="w-3 h-3" />}
                  onClick={addCustomRule}
                >
                  {t('add_custom_rule')}
                </Button>
              </div>

              <div className="space-y-2">
                {presetRules.map((rule, i) => (
                  <RuleCard
                    key={rule.name}
                    rule={{ ...rule, name: PRESET_LABELS[rule.name] || rule.name }}
                    onChange={(updated) => {
                      setPresetRules((prev) =>
                        prev.map((r, idx) => (idx === i ? { ...updated, name: rule.name } : r)),
                      );
                    }}
                    providerOptions={providerOptions}
                  />
                ))}

                {customRules.map((rule, i) => (
                  <RuleCard
                    key={`custom-${i}`}
                    rule={rule}
                    onChange={(updated) => updateCustomRule(i, updated)}
                    onRemove={() => removeCustomRule(i)}
                    providerOptions={providerOptions}
                    isCustom
                  />
                ))}
              </div>
            </div>

            {/* Settings */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-foreground">{t('settings_title')}</h4>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  {t('fail_mode_label')}
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="failMode"
                      checked={failMode === 'open'}
                      onChange={() => setFailMode('open')}
                      className="accent-accent"
                    />
                    {t('fail_mode_open')}
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="failMode"
                      checked={failMode === 'closed'}
                      onChange={() => setFailMode('closed')}
                      className="accent-accent"
                    />
                    {t('fail_mode_closed')}
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input
                  label={t('timeout_local_label')}
                  type="number"
                  min={100}
                  step={1000}
                  value={String(timeoutLocal)}
                  onChange={(e) => setTimeoutLocal(parseInt(e.target.value, 10) || 5000)}
                />
                <Input
                  label={t('timeout_model_label')}
                  type="number"
                  min={100}
                  step={1000}
                  value={String(timeoutModel)}
                  onChange={(e) => setTimeoutModel(parseInt(e.target.value, 10) || 10000)}
                />
                <Input
                  label={t('timeout_llm_label')}
                  type="number"
                  min={100}
                  step={1000}
                  value={String(timeoutLlm)}
                  onChange={(e) => setTimeoutLlm(parseInt(e.target.value, 10) || 30000)}
                />
              </div>

              <Toggle
                checked={streaming}
                onChange={setStreaming}
                label={t('streaming_label')}
                description={t('streaming_description')}
              />
            </div>

            {/* Status */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                {t('status_label')}
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    checked={status === 'draft'}
                    onChange={() => setStatus('draft')}
                    className="accent-accent"
                  />
                  {t('status_draft')}
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    checked={status === 'active'}
                    onChange={() => setStatus('active')}
                    className="accent-accent"
                  />
                  {t('status_active')}
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={!name.trim()}
            className="flex-1"
          >
            {initial ? t('update_policy') : t('create_policy')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx
git commit -m "feat(studio): add GuardrailPolicyForm with Form/YAML dual-mode"
```

---

### Task 7: Add Form/YAML tabs to `GuardrailProviderForm`

**Files:**

- Modify: `apps/studio/src/components/admin/GuardrailProviderForm.tsx`

**Step 1: Add imports for YAML editor and js-yaml**

Add at top of file, after existing imports:

```tsx
import { clsx } from 'clsx';
import { GuardrailYamlEditor, toYaml, fromYaml } from '../guardrails/GuardrailYamlEditor';
```

**Step 2: Expand `ADAPTER_TYPE_OPTIONS` to full list**

Replace the existing array with:

```tsx
const ADAPTER_TYPE_OPTIONS = [
  { value: 'openai_moderation', label: 'OpenAI Moderation' },
  { value: 'google_cloud', label: 'Google Cloud Safety' },
  { value: 'vertex_ai', label: 'Vertex AI' },
  { value: 'azure_content_safety', label: 'Azure Content Safety' },
  { value: 'bedrock', label: 'AWS Bedrock Guardrails' },
  { value: 'lakera', label: 'Lakera Guard' },
  { value: 'aporia', label: 'Aporia' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'builtin_pii', label: 'Built-in PII' },
  { value: 'openai_compatible', label: 'OpenAI-Compatible' },
  { value: 'huggingface_inference', label: 'HuggingFace Inference' },
  { value: 'custom_llm', label: 'Custom LLM' },
  { value: 'custom_http', label: 'Custom HTTP' },
  { value: 'custom_webhook', label: 'Custom Webhook' },
  { value: 'nemo_guardrails', label: 'NVIDIA NeMo Guardrails' },
];
```

**Step 3: Add tab state and YAML sync logic**

Inside the component function, after `const [saving, setSaving] = ...`:

```tsx
type ProviderFormTab = 'form' | 'yaml';
const [activeTab, setActiveTab] = useState<ProviderFormTab>('form');
const [yamlValue, setYamlValue] = useState('');

const formToObj = useCallback(
  (): Record<string, unknown> => ({
    name: name.trim(),
    displayName: displayName.trim() || undefined,
    adapterType: type,
    endpoint: endpoint.trim() || undefined,
    model: model.trim() || undefined,
    hosting,
    apiKey: apiKey.trim() || undefined,
    defaultCategory: defaultCategory.trim() || undefined,
    defaultThreshold: defaultThreshold ? parseFloat(defaultThreshold) : undefined,
    circuitBreaker: {
      maxFailures: parseInt(cbMaxFailures, 10) || 5,
      resetTimeout: parseInt(cbResetTimeout, 10) || 30000,
    },
    retry: {
      maxRetries: parseInt(retryMaxRetries, 10) || 3,
      backoff: retryBackoff,
    },
    isActive: enabled,
  }),
  [
    name,
    displayName,
    type,
    endpoint,
    model,
    hosting,
    apiKey,
    defaultCategory,
    defaultThreshold,
    cbMaxFailures,
    cbResetTimeout,
    retryMaxRetries,
    retryBackoff,
    enabled,
  ],
);

const switchToYaml = useCallback(() => {
  setYamlValue(toYaml(formToObj()));
  setActiveTab('yaml');
}, [formToObj]);

const switchToForm = useCallback(() => {
  const parsed = fromYaml(yamlValue);
  if (parsed) {
    if (typeof parsed.name === 'string') setName(parsed.name);
    if (typeof parsed.displayName === 'string') setDisplayName(parsed.displayName);
    if (typeof parsed.adapterType === 'string') setType(parsed.adapterType);
    if (typeof parsed.endpoint === 'string') setEndpoint(parsed.endpoint);
    if (typeof parsed.model === 'string') setModel(parsed.model);
    if (typeof parsed.hosting === 'string') setHosting(parsed.hosting as any);
    if (typeof parsed.defaultCategory === 'string') setDefaultCategory(parsed.defaultCategory);
    if (parsed.defaultThreshold != null) setDefaultThreshold(String(parsed.defaultThreshold));
    if (parsed.isActive != null) setEnabled(Boolean(parsed.isActive));
  }
  setActiveTab('form');
}, [yamlValue]);
```

**Step 4: Wrap existing form JSX with tab UI**

In the `return` JSX, after the title/description `<div>` and before the form fields, add the tab bar. Wrap existing form fields in `{activeTab === 'form' && (...)}` and add YAML editor for YAML tab. Follow the same tab pattern used in `GuardrailPolicyForm` (Task 6).

**Step 5: Update submit handler for YAML mode**

In `handleSubmit`, if `activeTab === 'yaml'`, parse YAML and submit that instead of form state. Same pattern as the policy form.

**Step 6: Commit**

```bash
git add apps/studio/src/components/admin/GuardrailProviderForm.tsx
git commit -m "feat(studio): add Form/YAML tabs and expanded adapter types to GuardrailProviderForm"
```

---

### Task 8: Wire provider CRUD into `GuardrailsConfigPage`

**Files:**

- Modify: `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`

**Step 1: Add imports**

```tsx
import { Pencil, Trash2, Plus } from 'lucide-react';
import { Button } from '../ui/Button';
import { toast } from 'sonner';
import { GuardrailProviderForm } from '../admin/GuardrailProviderForm';
import { GuardrailPolicyForm } from './GuardrailPolicyForm';
import type { CreateProviderInput, CreatePolicyInput } from '../../hooks/useGuardrails';
```

**Step 2: Update `ProvidersTab` to add CRUD**

Add state for dialog open/close and selected provider for editing. Add "Add Provider" button. Add edit/delete icons to each provider card. Wire `createProvider`, `updateProvider`, `deleteProvider` from `useGuardrailProviders()`.

Key additions:

- `const [showForm, setShowForm] = useState(false);`
- `const [editProvider, setEditProvider] = useState<GuardrailProvider | undefined>();`
- `const [deleteId, setDeleteId] = useState<string | null>(null);`
- "Add Provider" button in top bar opens form
- Pencil icon on card → `setEditProvider(provider)` → opens form with `initial`
- Trash icon → confirmation → calls `deleteProvider(id)`
- `<GuardrailProviderForm open={showForm || !!editProvider} onClose={...} onSubmit={...} initial={editProvider} />`

**Step 3: Update `PoliciesTab` to add CRUD**

Same pattern as providers. Add "Add Policy" button, edit/delete/activate actions on policy cards.

Key additions:

- `const [showForm, setShowForm] = useState(false);`
- `const [editPolicy, setEditPolicy] = useState<GuardrailPolicy | undefined>();`
- "Add Policy" button opens `GuardrailPolicyForm`
- Toggle icon on card → calls `activatePolicy(id, !isActive)`
- Pencil icon → edit mode
- Trash icon → confirmation → `deletePolicy(id)`
- `<GuardrailPolicyForm open={showForm || !!editPolicy} onClose={...} onSubmit={...} initial={editPolicy} projectId={projectId} />`

**Step 4: Commit**

```bash
git add apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx
git commit -m "feat(studio): wire provider and policy CRUD into GuardrailsConfigPage"
```

---

### Task 9: Prettier and build verification

**Files:**

- All modified files

**Step 1: Run prettier on all changed files**

```bash
npx prettier --write \
  apps/studio/src/components/guardrails/SeveritySelector.tsx \
  apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx \
  apps/studio/src/components/guardrails/RuleCard.tsx \
  apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx \
  apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx \
  apps/studio/src/components/admin/GuardrailProviderForm.tsx \
  packages/i18n/locales/en/studio.json
```

**Step 2: Build studio to verify no TypeScript errors**

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds with no type errors.

**Step 3: Fix any issues found, then commit**

```bash
git add -A
git commit -m "chore(studio): prettier formatting for guardrails UI components"
```

---

### Task 10: Manual smoke test

**No files changed — verification only.**

**Step 1: Start studio and runtime**

```bash
# Terminal 1
cd apps/runtime && pnpm dev

# Terminal 2
cd apps/studio && pnpm dev
```

**Step 2: Verify provider creation flow**

1. Login as `dev@kore.ai`
2. Navigate to any project → Guardrails Config page
3. Click "Providers" tab → "Add Provider" button
4. Fill form, switch to YAML tab, verify sync, switch back
5. Submit → verify provider appears in list
6. Click edit icon → verify form pre-populated
7. Click delete icon → verify confirmation → verify removal

**Step 3: Verify policy creation flow**

1. Stay on Guardrails Config page
2. Click "Policies" tab → "Add Policy" button
3. Toggle on "Content Safety" and "PII Protection" presets
4. Add a custom rule with CEL expression
5. Switch to YAML tab → verify all rules serialized
6. Submit → verify policy appears in list
7. Click activate toggle → verify status changes
8. Click edit → verify form re-populated
9. Click delete → verify removal

**Step 4: Verify agent-scoped policy**

1. Create new policy with scope "Agent"
2. Select an agent from dropdown
3. Submit → verify appears with agent scope badge
