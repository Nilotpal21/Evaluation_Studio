'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { RadioGroup } from '../ui/RadioGroup';
import { Toggle } from '../ui/Toggle';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Alert } from '../ui/Alert';
import { Skeleton } from '../ui/Skeleton';
import { Plus, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import { BUILTIN_GUARDRAIL_PROVIDERS } from '@agent-platform/database/constants/guardrail-adapters';
import { RuleCard, type RuleAction, type RuleData } from './RuleCard';
import { GuardrailYamlEditor, toYaml, fromYaml } from './GuardrailYamlEditor';
import { useGuardrailProviders, type GuardrailPolicy } from '../../hooks/useGuardrails';
import { fetchRuntimeAgents } from '../../api/runtime-agents';
import { apiFetch } from '../../lib/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

type FormTab = 'form' | 'yaml';
type ScopeType = 'tenant' | 'project' | 'agent';
type FailMode = 'open' | 'closed';
type PolicyStatus = 'draft' | 'active' | 'archived';
type StreamingInterval = 'token' | 'sentence' | 'chunk_size';

/** Metadata returned by onSubmit to signal auto-deactivation (T-RT-4). */
interface SubmitResult {
  autoDeactivated?: boolean;
}

interface GuardrailPolicyFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => Promise<SubmitResult | void>;
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
    {
      name: 'sensitive_data_block',
      enabled: false,
      kind: 'both',
      checkType: 'provider',
      provider: 'builtin-pii',
      category: 'pii',
      threshold: 0.7,
      action: 'block',
      message: 'Your message contains sensitive data and has been blocked.',
      presetKey: 'sensitive_data_block',
      entities: ['ssn'],
      actionMessage: 'Your message contains sensitive data and has been blocked.',
    },
  ];
}

const PRESET_LABEL_KEYS: Record<string, string> = {
  content_safety: 'preset_content_safety',
  prompt_injection: 'preset_prompt_injection',
  topic_restriction: 'preset_topic_restriction',
  sensitive_data_block: 'preset_sensitive_data_block',
};

const DEFAULT_TIMEOUTS = {
  local: 5000,
  model: 10000,
  llm: 30000,
} as const;

const DEFAULT_STREAMING = {
  enabled: false,
  defaultInterval: 'sentence' as StreamingInterval,
  chunkSize: 256,
  maxLatencyMs: 500,
  earlyTermination: true,
};

const DEFAULT_FAIL_MODE: FailMode = 'closed';
const DEFAULT_STATUS: PolicyStatus = 'draft';
const EMPTY_AGENT_OPTIONS: Array<{ value: string; label: string }> = [];
const READ_ONLY_POLICY_FIELDS = [
  '_id',
  '_v',
  'createdAt',
  'updatedAt',
  'tenantId',
  'scope',
  'isActive',
] as const;
const FORM_SUPPORTED_RULE_KEYS = new Set([
  'guardrailName',
  'name',
  'override',
  'kind',
  'provider',
  'category',
  'check',
  'llmCheck',
  'threshold',
  'action',
  // SDB (Sensitive Data Block) fields — ABLP-723
  'presetKey',
  'entities',
  'actionMessage',
  'enabled',
]);

// ─── PII Entity Catalog Types ───────────────────────────────────────────────

interface PiiEntity {
  id: string;
  label: string;
  category: string;
  pack: string;
}

// Human-readable labels for entity categories rendered in the catalog.
// Falls back to the raw key when no mapping exists.
const CATEGORY_LABELS: Record<string, string> = {
  contact: 'Contact',
  government_id: 'Government ID',
  financial: 'Financial',
  network: 'Network',
  medical: 'Medical',
  vehicle: 'Vehicle',
  location: 'Location',
  date_time: 'Date / Time',
};

interface PiiEntityCatalogResponse {
  success: boolean;
  data: { entities: PiiEntity[] };
}

/** Group PII entities by pack, then by category within each pack. */
function groupEntities(
  entities: PiiEntity[],
): Array<{ pack: string; categories: Array<{ category: string; entities: PiiEntity[] }> }> {
  const packMap = new Map<string, Map<string, PiiEntity[]>>();
  for (const entity of entities) {
    let catMap = packMap.get(entity.pack);
    if (!catMap) {
      catMap = new Map();
      packMap.set(entity.pack, catMap);
    }
    let list = catMap.get(entity.category);
    if (!list) {
      list = [];
      catMap.set(entity.category, list);
    }
    list.push(entity);
  }
  const groups: Array<{
    pack: string;
    categories: Array<{ category: string; entities: PiiEntity[] }>;
  }> = [];
  for (const [pack, catMap] of packMap) {
    const categories: Array<{ category: string; entities: PiiEntity[] }> = [];
    for (const [category, list] of catMap) {
      categories.push({ category, entities: list });
    }
    groups.push({ pack, categories });
  }
  return groups;
}

const SDB_DECISION_MATRIX_LS_KEY = 'sdb_decision_matrix_seen';

interface FormStateSnapshot {
  name: string;
  description: string;
  scopeType: ScopeType;
  agentDefId: string;
  presetRules: RuleData[];
  customRules: RuleData[];
  failMode: FailMode;
  timeoutLocal: number;
  timeoutModel: number;
  timeoutLlm: number;
  streaming: boolean;
  streamingInterval: StreamingInterval;
  streamingChunkSize: number;
  streamingMaxLatencyMs: number;
  streamingEarlyTermination: boolean;
  status: PolicyStatus;
  passthroughRules: Record<string, unknown>[];
  basePayload: Record<string, unknown>;
}

function createDefaultFormState(): FormStateSnapshot {
  return {
    name: '',
    description: '',
    scopeType: 'project',
    agentDefId: '',
    presetRules: createPresetRules(),
    customRules: [],
    failMode: DEFAULT_FAIL_MODE,
    timeoutLocal: DEFAULT_TIMEOUTS.local,
    timeoutModel: DEFAULT_TIMEOUTS.model,
    timeoutLlm: DEFAULT_TIMEOUTS.llm,
    streaming: DEFAULT_STREAMING.enabled,
    streamingInterval: DEFAULT_STREAMING.defaultInterval,
    streamingChunkSize: DEFAULT_STREAMING.chunkSize,
    streamingMaxLatencyMs: DEFAULT_STREAMING.maxLatencyMs,
    streamingEarlyTermination: DEFAULT_STREAMING.earlyTermination,
    status: DEFAULT_STATUS,
    passthroughRules: [],
    basePayload: {},
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coerceRuleAction(value: unknown): RuleAction {
  if (
    value === 'block' ||
    value === 'warn' ||
    value === 'redact' ||
    value === 'escalate' ||
    value === 'fix' ||
    value === 'reask' ||
    value === 'filter'
  ) {
    return value;
  }
  return 'block';
}

function getRuleAction(value: unknown): RuleAction {
  if (value && typeof value === 'object' && 'type' in value) {
    return coerceRuleAction((value as { type?: unknown }).type);
  }
  return 'block';
}

function getRuleMessage(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'message' in value) {
    return getString((value as { message?: unknown }).message);
  }
  return undefined;
}

function isSupportedRuleAction(value: unknown): value is { type: RuleAction; message?: string } {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (!Object.keys(value).every((key) => key === 'type' || key === 'message')) {
    return false;
  }

  return (
    value.type === 'block' ||
    value.type === 'warn' ||
    value.type === 'redact' ||
    value.type === 'escalate' ||
    value.type === 'fix' ||
    value.type === 'reask' ||
    value.type === 'filter'
  );
}

function canHydrateRuleForForm(rule: Record<string, unknown>): boolean {
  const override = getString(rule.override);
  if (override && override !== 'define') {
    return false;
  }

  const kind = getString(rule.kind);
  if (kind !== 'input' && kind !== 'output') {
    return false;
  }

  if (Object.keys(rule).some((key) => !FORM_SUPPORTED_RULE_KEYS.has(key))) {
    return false;
  }

  if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold)) {
    return false;
  }

  if (!isSupportedRuleAction(rule.action)) {
    return false;
  }

  const definedChecks = [
    getString(rule.check)?.trim(),
    getString(rule.provider)?.trim(),
    getString(rule.llmCheck)?.trim(),
  ].filter((value) => Boolean(value));

  return definedChecks.length === 1;
}

function toRuleData(rule: Record<string, unknown>): RuleData | null {
  const name = getString(rule.guardrailName) ?? getString(rule.name);
  if (!name) {
    return null;
  }

  const kind = rule.kind === 'input' || rule.kind === 'output' ? rule.kind : null;
  if (!kind) {
    return null;
  }

  const provider = getString(rule.provider)?.trim();
  const llmCheck = getString(rule.llmCheck)?.trim();
  const check = getString(rule.check)?.trim();
  const checkType = provider ? 'provider' : llmCheck ? 'llm' : check ? 'cel' : null;
  if (!checkType) {
    return null;
  }

  const presetKey = getString(rule.presetKey);
  const actionMessage = getString(rule.actionMessage);
  const entities = Array.isArray(rule.entities) ? (rule.entities as string[]) : undefined;

  return {
    name,
    enabled: rule.enabled === false ? false : true,
    kind,
    checkType,
    check,
    provider,
    category: getString(rule.category),
    llmCheck,
    threshold: getNumber(rule.threshold, 0.5),
    action: getRuleAction(rule.action),
    message: getRuleMessage(rule.action),
    ...(presetKey ? { presetKey } : {}),
    ...(entities ? { entities } : {}),
    ...(actionMessage ? { actionMessage } : {}),
  };
}

function combineKinds(first: RuleData['kind'], second: RuleData['kind']): RuleData['kind'] | null {
  if (first === second) return first;
  const pair = new Set([first, second]);
  if (pair.has('input') && pair.has('output') && pair.size === 2) {
    return 'both';
  }
  return null;
}

function collapseRulesForForm(rules: RuleData[]): RuleData[] {
  const collapsed: RuleData[] = [];

  for (const rule of rules) {
    const existing = collapsed.find(
      (candidate) =>
        candidate.name === rule.name &&
        candidate.checkType === rule.checkType &&
        (candidate.check ?? '') === (rule.check ?? '') &&
        (candidate.provider ?? '') === (rule.provider ?? '') &&
        (candidate.category ?? '') === (rule.category ?? '') &&
        (candidate.llmCheck ?? '') === (rule.llmCheck ?? '') &&
        candidate.threshold === rule.threshold &&
        candidate.action === rule.action &&
        (candidate.message ?? '') === (rule.message ?? ''),
    );

    if (!existing) {
      collapsed.push({ ...rule });
      continue;
    }

    const combinedKind = combineKinds(existing.kind, rule.kind);
    if (combinedKind) {
      existing.kind = combinedKind;
      continue;
    }

    collapsed.push({ ...rule });
  }

  return collapsed;
}

function splitRulesForForm(
  rules: unknown,
): Pick<FormStateSnapshot, 'presetRules' | 'customRules' | 'passthroughRules'> {
  const presetRules = createPresetRules();
  const customRules: RuleData[] = [];
  const passthroughRules: Record<string, unknown>[] = [];

  const hydrated = Array.isArray(rules)
    ? collapseRulesForForm(
        (rules as unknown[]).flatMap((rule) => {
          if (!isObjectRecord(rule)) {
            return [];
          }

          if (!canHydrateRuleForForm(rule)) {
            passthroughRules.push(clonePayload(rule));
            return [];
          }

          const hydratedRule = toRuleData(rule);
          return hydratedRule ? [hydratedRule] : [];
        }),
      )
    : [];

  for (const rule of hydrated) {
    const presetIndex = presetRules.findIndex((preset) => preset.name === rule.name);
    if (presetIndex >= 0) {
      presetRules[presetIndex] = {
        ...presetRules[presetIndex],
        ...rule,
        name: presetRules[presetIndex].name,
        // Preserve the stored enabled flag so a disabled SDB rule stays disabled
        // when re-edited. Legacy rules persisted before the field existed default
        // to enabled (rule.enabled === undefined → undefined !== false → true).
        enabled: rule.enabled !== false,
      };
      continue;
    }

    customRules.push(rule);
  }

  return { presetRules, customRules, passthroughRules };
}

function buildFormStateFromPayloadSource(rawPayload?: Record<string, unknown>): FormStateSnapshot {
  const defaults = createDefaultFormState();
  if (!rawPayload) {
    return defaults;
  }

  const payload = normalizeYamlPayload(clonePayload(rawPayload));
  const { presetRules, customRules, passthroughRules } = splitRulesForForm(payload.rules);
  const settings = isObjectRecord(payload.settings) ? payload.settings : undefined;
  const timeouts = isObjectRecord(settings?.timeouts) ? settings.timeouts : undefined;
  const streaming = isObjectRecord(settings?.streaming) ? settings.streaming : undefined;
  const scopeType =
    payload.scopeType === 'tenant' ||
    payload.scopeType === 'agent' ||
    payload.scopeType === 'project'
      ? payload.scopeType
      : defaults.scopeType;

  return {
    ...defaults,
    name: getString(payload.name) ?? '',
    description: getString(payload.description) ?? '',
    scopeType,
    agentDefId: getString(payload.agentDefId) ?? '',
    presetRules,
    customRules,
    failMode:
      settings?.failMode === 'open'
        ? 'open'
        : settings?.failMode === 'closed'
          ? 'closed'
          : defaults.failMode,
    timeoutLocal: getNumber(timeouts?.local, defaults.timeoutLocal),
    timeoutModel: getNumber(timeouts?.model, defaults.timeoutModel),
    timeoutLlm: getNumber(timeouts?.llm, defaults.timeoutLlm),
    streaming: typeof streaming?.enabled === 'boolean' ? streaming.enabled : defaults.streaming,
    streamingInterval:
      streaming?.defaultInterval === 'token' ||
      streaming?.defaultInterval === 'sentence' ||
      streaming?.defaultInterval === 'chunk_size'
        ? streaming.defaultInterval
        : defaults.streamingInterval,
    streamingChunkSize: getNumber(streaming?.chunkSize, defaults.streamingChunkSize),
    streamingMaxLatencyMs: getNumber(streaming?.maxLatencyMs, defaults.streamingMaxLatencyMs),
    streamingEarlyTermination:
      typeof streaming?.earlyTermination === 'boolean'
        ? streaming.earlyTermination
        : defaults.streamingEarlyTermination,
    status:
      payload.status === 'active' || payload.status === 'archived'
        ? payload.status
        : defaults.status,
    passthroughRules,
    basePayload: payload,
  };
}

function buildFormStateFromInitial(initial?: GuardrailPolicy): FormStateSnapshot {
  return buildFormStateFromPayloadSource(initial as unknown as Record<string, unknown> | undefined);
}

function buildFormStateFromPayload(parsed: Record<string, unknown>): FormStateSnapshot {
  return buildFormStateFromPayloadSource(parsed);
}

/**
 * Returns the first enabled rule that would be silently dropped by
 * `serializeRule` because the field required by its `checkType` is missing.
 * Used by the form's pre-submit gate so the user sees a clear error instead
 * of a misleading "policy updated" toast for a rule that never reached the
 * server. The SDB entities case is handled separately via `sdbEntityError`.
 */
function findIncompleteEnabledRule(
  presetRules: RuleData[],
  customRules: RuleData[],
): { rule: RuleData; field: 'check' | 'provider' | 'llm_check' | 'name' } | null {
  const all = [...presetRules, ...customRules];
  for (const rule of all) {
    if (!rule.enabled) continue;
    if (!rule.name?.trim()) return { rule, field: 'name' };
    if (rule.checkType === 'cel' && !rule.check?.trim()) return { rule, field: 'check' };
    if (rule.checkType === 'provider' && !rule.provider?.trim()) return { rule, field: 'provider' };
    if (rule.checkType === 'llm' && !rule.llmCheck?.trim()) return { rule, field: 'llm_check' };
  }
  return null;
}

function serializeRule(rule: RuleData): Record<string, unknown>[] {
  // ABLP-723 (R1-F7): SDB-preset disabled rules MUST persist with `enabled: false`
  // so the server can count them for the activation gate + auto-deactivation.
  // Non-SDB rules retain the legacy "filter out disabled" behavior.
  if (!rule.enabled && rule.presetKey !== 'sensitive_data_block') {
    return [];
  }

  const guardrailName = rule.name.trim();
  if (!guardrailName) {
    return [];
  }

  const base: Record<string, unknown> = {
    guardrailName,
    override: 'define',
    threshold: rule.threshold,
    action: { type: rule.action, message: rule.message || undefined },
    ...(rule.presetKey ? { presetKey: rule.presetKey } : {}),
    ...(rule.entities ? { entities: rule.entities } : {}),
    ...(rule.actionMessage ? { actionMessage: rule.actionMessage } : {}),
    enabled: rule.enabled,
  };

  if (rule.checkType === 'cel') {
    const check = rule.check?.trim();
    if (!check) {
      return [];
    }
    base.check = check;
  }

  if (rule.checkType === 'provider') {
    const provider = rule.provider?.trim();
    if (!provider) {
      return [];
    }
    base.provider = provider;
    const category = rule.category?.trim();
    if (category) {
      base.category = category;
    }
  }

  if (rule.checkType === 'llm') {
    const llmCheck = rule.llmCheck?.trim();
    if (!llmCheck) {
      return [];
    }
    base.llmCheck = llmCheck;
  }

  if (rule.kind === 'both') {
    return [
      { ...base, kind: 'input' },
      { ...base, kind: 'output' },
    ];
  }

  return [{ ...base, kind: rule.kind }];
}

// ─── Form State → API Payload ────────────────────────────────────────────────

function buildPayload(
  basePayload: Record<string, unknown>,
  name: string,
  description: string,
  scopeType: ScopeType,
  agentDefId: string,
  rules: RuleData[],
  customRules: RuleData[],
  passthroughRules: Record<string, unknown>[],
  failMode: FailMode,
  timeouts: { local: number; model: number; llm: number },
  streaming: boolean,
  streamingInterval: StreamingInterval,
  streamingChunkSize: number,
  streamingMaxLatencyMs: number,
  streamingEarlyTermination: boolean,
  status: PolicyStatus,
): Record<string, unknown> {
  const enabledRules = [...rules, ...customRules].flatMap(serializeRule);
  const payload = clonePayload(basePayload);

  for (const field of READ_ONLY_POLICY_FIELDS) {
    delete payload[field];
  }

  payload.name = name;
  if (description) {
    payload.description = description;
  } else {
    delete payload.description;
  }

  // scopeType and agentDefId must be top-level — the route's buildScope() reads
  // body.scopeType, and 'scope' is in PROTECTED_FIELDS (stripped by sanitizeBody)
  payload.scopeType = scopeType;
  if (scopeType === 'agent' && agentDefId) {
    payload.agentDefId = agentDefId;
  } else {
    delete payload.agentDefId;
  }

  payload.rules = [...enabledRules, ...passthroughRules.map((rule) => clonePayload(rule))];
  payload.status = status;

  const existingSettings = isObjectRecord(payload.settings) ? payload.settings : {};
  const existingTimeouts = isObjectRecord(existingSettings.timeouts)
    ? existingSettings.timeouts
    : {};
  const existingStreaming = isObjectRecord(existingSettings.streaming)
    ? existingSettings.streaming
    : {};

  payload.settings = {
    ...existingSettings,
    failMode,
    timeouts: {
      ...existingTimeouts,
      ...timeouts,
    },
    streaming: {
      ...existingStreaming,
      enabled: streaming,
      defaultInterval: streamingInterval,
      chunkSize: streamingChunkSize,
      maxLatencyMs: streamingMaxLatencyMs,
      earlyTermination: streamingEarlyTermination,
    },
  };

  return payload;
}

// ─── YAML Payload Normalizer ─────────────────────────────────────────────────
// The YAML editor lets power users write policies freehand. They may use the
// legacy field names (rules[].name, nested scope object) or omit required fields
// like `override`. This normalizes any valid-looking YAML to the API shape that
// the runtime route expects.

function normalizeYamlPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  // Scope: move nested scope.type → top-level scopeType (PROTECTED_FIELDS strips scope)
  if (raw.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope)) {
    const sc = raw.scope as Record<string, unknown>;
    if (typeof sc.type === 'string' && out.scopeType === undefined) {
      out.scopeType = sc.type;
    }
    if (typeof sc.agentDefId === 'string' && out.agentDefId === undefined) {
      out.agentDefId = sc.agentDefId;
    }
    delete out.scope;
  }

  // Rules: normalize each rule
  if (Array.isArray(raw.rules)) {
    const normalized: Record<string, unknown>[] = [];
    for (const r of raw.rules as Record<string, unknown>[]) {
      const rule: Record<string, unknown> = { ...r };

      // Rename legacy `name` → `guardrailName`
      if (rule.guardrailName === undefined && typeof rule.name === 'string') {
        rule.guardrailName = rule.name;
        delete rule.name;
      }

      // Default `override` to 'define' when absent
      if (rule.override === undefined) {
        rule.override = 'define';
      }

      const guardrailName = getString(rule.guardrailName)?.trim();
      if (!guardrailName) {
        continue;
      }
      rule.guardrailName = guardrailName;

      // Expand kind:'both' into two rules (DB enum only accepts input/output/…)
      const expandedRules =
        rule.kind === 'both'
          ? [
              { ...rule, kind: 'input' },
              { ...rule, kind: 'output' },
            ]
          : [rule];

      for (const normalizedRule of expandedRules) {
        if (normalizedRule.override === 'define') {
          const hasExecutableCheck = Boolean(
            getString(normalizedRule.check)?.trim() ||
            getString(normalizedRule.provider)?.trim() ||
            getString(normalizedRule.llmCheck)?.trim(),
          );

          if (!hasExecutableCheck) {
            continue;
          }
        }

        normalized.push(normalizedRule);
      }
    }
    out.rules = normalized;
  }

  return out;
}

// ─── Entity Multi-select Sub-component ──────────────────────────────────────

function EntityMultiselect({
  projectId,
  selectedEntities,
  onChange,
  hasError,
  t,
}: {
  projectId: string;
  selectedEntities: string[];
  onChange: (entities: string[]) => void;
  hasError: boolean;
  t: (key: string) => string;
}) {
  const {
    data,
    error,
    isLoading,
    mutate: retryCatalog,
  } = useSWR<PiiEntityCatalogResponse>(
    projectId ? `/api/projects/${projectId}/pii-entities` : null,
    { keepPreviousData: true },
  );

  const entities = data?.data?.entities ?? [];
  const groups = useMemo(() => groupEntities(entities), [entities]);

  const toggleEntity = useCallback(
    (entityId: string) => {
      onChange(
        selectedEntities.includes(entityId)
          ? selectedEntities.filter((id) => id !== entityId)
          : [...selectedEntities, entityId],
      );
    },
    [selectedEntities, onChange],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 pl-2">
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error" title={t('entity_select_load_error')}>
        <span>{t('entity_select_fetch_error')} </span>
        <button
          type="button"
          onClick={() => void retryCatalog()}
          className="underline font-medium hover:opacity-80"
        >
          {t('entity_select_retry')}
        </button>
      </Alert>
    );
  }

  if (entities.length === 0) {
    return <p className="text-sm text-muted">{t('entity_select_empty')}</p>;
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-foreground">
        {t('entity_select_label')}
        {hasError && (
          <span className="ml-2 text-xs text-error font-normal">{t('entity_select_required')}</span>
        )}
      </label>
      {groups.map((group) => (
        <div key={group.pack} className="space-y-2">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide">{group.pack}</p>
          {group.categories.map((cat) => (
            <div key={`${group.pack}-${cat.category}`} className="space-y-1 pl-2">
              <p className="text-xs font-medium text-foreground-muted">
                {CATEGORY_LABELS[cat.category] ?? cat.category}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {cat.entities.map((entity) => (
                  <Checkbox
                    key={entity.id}
                    checked={selectedEntities.includes(entity.id)}
                    onChange={() => toggleEntity(entity.id)}
                    label={entity.label}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Decision Matrix Modal Sub-component ────────────────────────────────────

function DecisionMatrixModal({
  open,
  onClose,
  t,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const rows = useMemo(
    () => [
      {
        action: 'block',
        input: t('decision_matrix_block_input'),
        output: t('decision_matrix_block_output'),
      },
      {
        action: 'warn',
        input: t('decision_matrix_warn_input'),
        output: t('decision_matrix_warn_output'),
      },
      {
        action: 'escalate',
        input: t('decision_matrix_escalate_input'),
        output: t('decision_matrix_escalate_output'),
      },
    ],
    [t],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('decision_matrix_title')}
      description={t('decision_matrix_description')}
      maxWidth="lg"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-default">
              <th className="text-left py-2 pr-4 text-foreground font-semibold">
                {t('decision_matrix_col_action')}
              </th>
              <th className="text-left py-2 px-4 text-foreground font-semibold">
                {t('decision_matrix_col_input')}
              </th>
              <th className="text-left py-2 pl-4 text-foreground font-semibold">
                {t('decision_matrix_col_output')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.action} className="border-b border-default last:border-b-0">
                <td className="py-2.5 pr-4 font-medium text-foreground capitalize">{row.action}</td>
                <td className="py-2.5 px-4 text-muted">{row.input}</td>
                <td className="py-2.5 pl-4 text-muted">{row.output}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

// ─── FailMode Open Banner Sub-component ─────────────────────────────────────

function FailModeOpenBanner({
  failMode,
  rules,
  t,
}: {
  failMode: FailMode;
  rules: RuleData[];
  t: (key: string) => string;
}) {
  if (failMode !== 'open') return null;
  const hasOutputRule = rules.some(
    (rule) => rule.enabled && (rule.kind === 'output' || rule.kind === 'both'),
  );
  if (!hasOutputRule) return null;

  return (
    <Alert variant="warning" title={t('fail_open_banner_title')}>
      {t('fail_open_banner_message')}
    </Alert>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GuardrailPolicyForm({
  open,
  onClose,
  onSubmit,
  initial,
  projectId,
  agents,
}: GuardrailPolicyFormProps) {
  const t = useTranslations('admin.guardrails');
  const { providers } = useGuardrailProviders();
  const initialState = useMemo(() => buildFormStateFromInitial(initial), [initial]);
  const providedAgents = agents ?? EMPTY_AGENT_OPTIONS;
  const hasProvidedAgents = providedAgents.length > 0;

  // Tab state
  const [activeTab, setActiveTab] = useState<FormTab>('form');
  const [yamlValue, setYamlValue] = useState('');

  // Basic fields
  const [name, setName] = useState(initialState.name);
  const [description, setDescription] = useState(initialState.description);

  // Scope
  const [scopeType, setScopeType] = useState<ScopeType>(initialState.scopeType);
  const [agentDefId, setAgentDefId] = useState(initialState.agentDefId);

  // Rules (presets + custom)
  const [presetRules, setPresetRules] = useState<RuleData[]>(initialState.presetRules);
  const [customRules, setCustomRules] = useState<RuleData[]>(initialState.customRules);
  const [passthroughRules, setPassthroughRules] = useState<Record<string, unknown>[]>(
    initialState.passthroughRules,
  );
  const [basePayload, setBasePayload] = useState<Record<string, unknown>>(initialState.basePayload);
  // FR-7: when editing an active policy and the user disables all rules, prompt
  // before saving (the server will auto-deactivate the policy on save).
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);

  // Settings
  const [failMode, setFailMode] = useState<FailMode>(initialState.failMode);
  const [timeoutLocal, setTimeoutLocal] = useState(initialState.timeoutLocal);
  const [timeoutModel, setTimeoutModel] = useState(initialState.timeoutModel);
  const [timeoutLlm, setTimeoutLlm] = useState(initialState.timeoutLlm);
  const [streaming, setStreaming] = useState(initialState.streaming);
  const [streamingInterval, setStreamingInterval] = useState<StreamingInterval>(
    initialState.streamingInterval,
  );
  const [streamingChunkSize, setStreamingChunkSize] = useState(initialState.streamingChunkSize);
  const [streamingMaxLatencyMs, setStreamingMaxLatencyMs] = useState(
    initialState.streamingMaxLatencyMs,
  );
  const [streamingEarlyTermination, setStreamingEarlyTermination] = useState(
    initialState.streamingEarlyTermination,
  );

  // Status
  const [status, setStatus] = useState<PolicyStatus>(initialState.status);
  const [fetchedAgents, setFetchedAgents] = useState<{ value: string; label: string }[]>([]);

  const [saving, setSaving] = useState(false);

  // Decision matrix modal state
  const [matrixOpen, setMatrixOpen] = useState(false);
  const matrixFirstRunChecked = useRef(false);

  // Track SDB entity validation error
  const [sdbEntityError, setSdbEntityError] = useState(false);

  // Prior rule snapshot for undo toast
  const priorRulesSnapshot = useRef<RuleData[] | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-open decision matrix on first run for SDB-preset rules
  useEffect(() => {
    if (!open || matrixFirstRunChecked.current) return;
    matrixFirstRunChecked.current = true;
    const hasSdb = presetRules.some((r) => r.presetKey === 'sensitive_data_block' && r.enabled);
    if (hasSdb) {
      try {
        const seen = localStorage.getItem(SDB_DECISION_MATRIX_LS_KEY);
        if (!seen) {
          setMatrixOpen(true);
          localStorage.setItem(SDB_DECISION_MATRIX_LS_KEY, '1');
        }
      } catch {
        // localStorage unavailable — skip auto-open
      }
    }
  }, [open, presetRules]);

  // Reset first-run ref when dialog closes
  useEffect(() => {
    if (!open) {
      matrixFirstRunChecked.current = false;
      setSdbEntityError(false);
    }
  }, [open]);

  // Cleanup undo timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  // Provider options for rule cards
  const providerOptions = useMemo(() => {
    const options = providers
      .filter((provider) => provider.isActive !== false)
      .map((provider) => ({
        value: provider.name,
        label: provider.displayName || provider.name,
      }));
    const seen = new Set(options.map((option) => option.value));

    for (const provider of BUILTIN_GUARDRAIL_PROVIDERS) {
      if (!seen.has(provider.name)) {
        options.push({ value: provider.name, label: provider.displayName });
      }
    }

    return options;
  }, [providers]);

  // Agent options for scope selector
  const agentOptions = useMemo(
    () => [
      { value: '', label: t('agent_select_default') },
      ...(hasProvidedAgents ? providedAgents : fetchedAgents),
    ],
    [providedAgents, fetchedAgents, hasProvidedAgents, t],
  );

  const scopeOptions = useMemo(() => {
    const options: Array<{ value: ScopeType; label: string }> = [
      { value: 'project', label: t('scope_project') },
      { value: 'agent', label: t('scope_agent') },
    ];

    if (scopeType === 'tenant' || initialState.scopeType === 'tenant') {
      options.unshift({ value: 'tenant', label: t('scope_tenant') });
    }

    return options;
  }, [initialState.scopeType, scopeType, t]);

  const applyFormState = useCallback((nextState: FormStateSnapshot) => {
    setName(nextState.name);
    setDescription(nextState.description);
    setScopeType(nextState.scopeType);
    setAgentDefId(nextState.agentDefId);
    setPresetRules(nextState.presetRules);
    setCustomRules(nextState.customRules);
    setFailMode(nextState.failMode);
    setTimeoutLocal(nextState.timeoutLocal);
    setTimeoutModel(nextState.timeoutModel);
    setTimeoutLlm(nextState.timeoutLlm);
    setStreaming(nextState.streaming);
    setStreamingInterval(nextState.streamingInterval);
    setStreamingChunkSize(nextState.streamingChunkSize);
    setStreamingMaxLatencyMs(nextState.streamingMaxLatencyMs);
    setStreamingEarlyTermination(nextState.streamingEarlyTermination);
    setStatus(nextState.status);
    setPassthroughRules(nextState.passthroughRules);
    setBasePayload(nextState.basePayload);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    applyFormState(initialState);
    setActiveTab('form');
    setYamlValue('');
  }, [open, initial?._id, initialState, applyFormState]);

  useEffect(() => {
    let cancelled = false;

    if (!open || !projectId || hasProvidedAgents) {
      setFetchedAgents((current) => (current.length > 0 ? [] : current));
      return () => {
        cancelled = true;
      };
    }

    void fetchRuntimeAgents(projectId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setFetchedAgents(
          result.agents.map((agent) => ({
            value: agent.name,
            label: agent.name,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedAgents([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId, hasProvidedAgents]);

  // ── Tab switching with bidirectional sync ──

  const switchToYaml = useCallback(() => {
    const obj = buildPayload(
      basePayload,
      name,
      description,
      scopeType,
      agentDefId,
      presetRules,
      customRules,
      passthroughRules,
      failMode,
      { local: timeoutLocal, model: timeoutModel, llm: timeoutLlm },
      streaming,
      streamingInterval,
      streamingChunkSize,
      streamingMaxLatencyMs,
      streamingEarlyTermination,
      status,
    );
    setYamlValue(toYaml(obj));
    setActiveTab('yaml');
  }, [
    basePayload,
    name,
    description,
    scopeType,
    agentDefId,
    presetRules,
    customRules,
    passthroughRules,
    failMode,
    timeoutLocal,
    timeoutModel,
    timeoutLlm,
    streaming,
    streamingInterval,
    streamingChunkSize,
    streamingMaxLatencyMs,
    streamingEarlyTermination,
    status,
  ]);

  const switchToForm = useCallback(() => {
    const parsed = fromYaml(yamlValue);
    if (parsed) {
      applyFormState(buildFormStateFromPayload(parsed));
    }
    setActiveTab('form');
  }, [yamlValue, applyFormState]);

  // ── Submit ──

  const performSubmit = async (skipDeactivateConfirm = false) => {
    setSaving(true);
    try {
      let payload: Record<string, unknown>;
      if (activeTab === 'yaml') {
        const parsed = fromYaml(yamlValue);
        if (!parsed) {
          toast.error(t('yaml_invalid_error'));
          setSaving(false);
          return;
        }
        payload = normalizeYamlPayload(parsed);
        const yamlName = getString(payload.name)?.trim();
        if (!yamlName) {
          toast.error(t('yaml_name_required_error'));
          setSaving(false);
          return;
        }
        payload.name = yamlName;
      } else {
        payload = buildPayload(
          basePayload,
          name,
          description,
          scopeType,
          agentDefId,
          presetRules,
          customRules,
          passthroughRules,
          failMode,
          { local: timeoutLocal, model: timeoutModel, llm: timeoutLlm },
          streaming,
          streamingInterval,
          streamingChunkSize,
          streamingMaxLatencyMs,
          streamingEarlyTermination,
          status,
        );
      }
      const result = await onSubmit(payload);
      if (result && (result as SubmitResult).autoDeactivated) {
        toast.success(t('policy_auto_deactivated'));
      } else {
        toast.success(initial ? t('policy_updated') : t('policy_created'));
      }
      setConfirmDeactivateOpen(false);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('policy_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (activeTab === 'form' && !name.trim()) return;

    // FR-8: SDB preset rules cannot be enabled without at least one entity selected.
    // Surface as an inline error on the entity multiselect (sdbEntityError) instead
    // of letting the request reach the server and surface as a confusing 400 toast.
    if (activeTab === 'form') {
      const sdbMissingEntities = presetRules.some(
        (r) =>
          r.presetKey === 'sensitive_data_block' &&
          r.enabled &&
          (!r.entities || r.entities.length === 0),
      );
      if (sdbMissingEntities) {
        setSdbEntityError(true);
        return;
      }

      // Any enabled rule that is missing the field required by its checkType
      // would be silently dropped by `serializeRule` — block the save and tell
      // the user instead of returning a misleading "policy updated" toast.
      const incompleteRule = findIncompleteEnabledRule(presetRules, customRules);
      if (incompleteRule) {
        toast.error(
          t('rule_incomplete_error', {
            rule: PRESET_LABEL_KEYS[incompleteRule.rule.name]
              ? t(PRESET_LABEL_KEYS[incompleteRule.rule.name])
              : incompleteRule.rule.name || t('rule_unnamed'),
            field: t(`rule_field_${incompleteRule.field}`),
          }),
        );
        return;
      }

      // FR-7: editing an active policy down to zero enabled rules will auto-deactivate
      // server-side. Warn before save so the user can cancel.
      if (initial?.isActive === true) {
        const allRules: Array<{ enabled?: boolean }> = [
          ...presetRules,
          ...customRules,
          ...(passthroughRules as Array<{ enabled?: boolean }>),
        ];
        const allDisabled = allRules.every((r) => !r?.enabled);
        if (allDisabled) {
          setConfirmDeactivateOpen(true);
          return;
        }
      }
    }

    await performSubmit();
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
    <>
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
                <RadioGroup
                  label={t('scope_label')}
                  options={scopeOptions}
                  value={scopeType}
                  onChange={(v) => setScopeType(v as ScopeType)}
                />
                {scopeType === 'agent' && (
                  <Select
                    label={t('agent_select_label')}
                    options={agentOptions}
                    value={agentDefId}
                    onChange={setAgentDefId}
                  />
                )}
              </div>

              {/* T-UI-4: failMode open banner */}
              <FailModeOpenBanner
                failMode={failMode}
                rules={[...presetRules, ...customRules]}
                t={t}
              />

              {/* Rules — presets */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">{t('rules_title')}</h4>
                      <p className="text-xs text-muted mt-0.5">{t('rules_description')}</p>
                    </div>
                    {/* T-UI-3: Decision matrix help button */}
                    <button
                      type="button"
                      onClick={() => setMatrixOpen(true)}
                      className="p-1 rounded-lg hover:bg-background-muted text-muted hover:text-foreground transition-default"
                      aria-label={t('open_decision_matrix_aria')}
                    >
                      <HelpCircle className="w-4 h-4" />
                    </button>
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
                    <div key={rule.name} className="space-y-2">
                      <RuleCard
                        rule={{
                          ...rule,
                          name: PRESET_LABEL_KEYS[rule.name]
                            ? t(PRESET_LABEL_KEYS[rule.name])
                            : rule.name,
                        }}
                        onChange={(updated) => {
                          setPresetRules((prev) =>
                            prev.map((r, idx) => (idx === i ? { ...updated, name: rule.name } : r)),
                          );
                        }}
                        providerOptions={providerOptions}
                        // FR-1.2 — SDB action vocabulary matches the Decision Matrix (3 actions).
                        allowedActions={
                          rule.presetKey === 'sensitive_data_block'
                            ? ['block', 'warn', 'escalate']
                            : undefined
                        }
                      />
                      {/* T-UI-2: Entity multi-select for SDB preset */}
                      {rule.presetKey === 'sensitive_data_block' && rule.enabled && (
                        <div className="ml-4 pl-4 border-l-2 border-default">
                          <EntityMultiselect
                            projectId={projectId}
                            selectedEntities={rule.entities ?? []}
                            onChange={(entities) => {
                              setPresetRules((prev) =>
                                prev.map((r, idx) => (idx === i ? { ...r, entities } : r)),
                              );
                              if (entities.length > 0) {
                                setSdbEntityError(false);
                              }
                            }}
                            hasError={sdbEntityError}
                            t={t}
                          />
                        </div>
                      )}
                    </div>
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

                <RadioGroup
                  label={t('fail_mode_label')}
                  options={[
                    { value: 'open', label: t('fail_mode_open') },
                    { value: 'closed', label: t('fail_mode_closed') },
                  ]}
                  value={failMode}
                  onChange={(v) => setFailMode(v as FailMode)}
                />

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

                {streaming && (
                  <div className="pl-4 border-l-2 border-default space-y-4">
                    <Select
                      label={t('streaming_interval_label')}
                      options={[
                        { value: 'sentence', label: t('streaming_interval_sentence') },
                        { value: 'token', label: t('streaming_interval_token') },
                        { value: 'chunk_size', label: t('streaming_interval_chunk_size') },
                      ]}
                      value={streamingInterval}
                      onChange={(v) => setStreamingInterval(v as StreamingInterval)}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label={t('streaming_chunk_size_label')}
                        type="number"
                        min={1}
                        step={64}
                        value={String(streamingChunkSize)}
                        onChange={(e) => setStreamingChunkSize(parseInt(e.target.value, 10) || 256)}
                      />
                      <Input
                        label={t('streaming_max_latency_label')}
                        type="number"
                        min={100}
                        step={100}
                        value={String(streamingMaxLatencyMs)}
                        onChange={(e) =>
                          setStreamingMaxLatencyMs(parseInt(e.target.value, 10) || 500)
                        }
                      />
                    </div>
                    <Toggle
                      checked={streamingEarlyTermination}
                      onChange={setStreamingEarlyTermination}
                      label={t('streaming_early_termination_label')}
                      description={t('streaming_early_termination_description')}
                    />
                  </div>
                )}
              </div>

              {/* Status */}
              <RadioGroup
                label={t('status_label')}
                options={[
                  { value: 'draft', label: t('status_draft') },
                  { value: 'active', label: t('status_active') },
                  { value: 'archived', label: t('status_archived') },
                ]}
                value={status}
                onChange={(v) => setStatus(v as PolicyStatus)}
              />
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
              disabled={activeTab === 'form' && !name.trim()}
              className="flex-1"
            >
              {initial ? t('update_policy') : t('create_policy')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* T-UI-3: Decision matrix modal */}
      <DecisionMatrixModal open={matrixOpen} onClose={() => setMatrixOpen(false)} t={t} />

      {/* FR-7: confirm auto-deactivation when saving an active policy with no enabled rules */}
      <ConfirmDialog
        open={confirmDeactivateOpen}
        onClose={() => setConfirmDeactivateOpen(false)}
        onConfirm={() => performSubmit(true)}
        title={t('confirm_deactivate_title')}
        description={t('confirm_deactivate_description')}
        confirmLabel={t('confirm_deactivate_button')}
        variant="danger"
        loading={saving}
      />
    </>
  );
}
