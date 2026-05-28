/**
 * PipelineTestDrawer Component
 *
 * Shared manual test drawer for builtin and custom pipelines.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { TriggerEntry } from '@agent-platform/pipeline-engine';
import { apiFetch, handleResponse } from '../../lib/api-client';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { SlidePanel } from '../ui/SlidePanel';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/ErrorAlert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TranslationFn = ReturnType<typeof useTranslations<any>>;

export type PipelineTestTrigger = TriggerEntry & {
  active?: boolean;
};

interface PipelineTestDrawerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  pipelineId: string;
  triggers: PipelineTestTrigger[];
  onRunCreated?: (runId: string) => void;
}

type TriggerInputSchema = TriggerEntry['inputSchema'];

interface TriggerProperty {
  type: string;
  description?: string;
}

function buildStringTemplate(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized.includes('session')) return 'session-test-001';
  if (normalized.includes('message')) return 'msg-test-001';
  if (normalized.includes('channel')) return 'web';
  if (normalized.includes('agent')) return 'support-agent';
  return 'example';
}

/**
 * Fallback schema walker — used only when the trigger has no exampleOutput
 * on file (legacy pipelines saved before ABLP-564 Phase 1 shipped
 * `exampleOutput` on every trigger). Strips tenantId/projectId because those
 * are injected server-side from auth context, not the test payload.
 */
function buildTemplateFromInputSchema(
  schema: TriggerInputSchema | undefined,
): Record<string, unknown> {
  if (!schema?.properties) {
    return {};
  }

  const template: Record<string, unknown> = {};

  Object.entries(schema.properties).forEach(([key, property]) => {
    if (key === 'tenantId' || key === 'projectId') {
      return;
    }

    const prop = property as TriggerProperty;
    switch (prop.type) {
      case 'boolean':
        template[key] = false;
        break;
      case 'number':
      case 'integer':
        template[key] = 0;
        break;
      case 'array':
        template[key] = [];
        break;
      case 'object':
        template[key] = {};
        break;
      default:
        template[key] = buildStringTemplate(key);
        break;
    }
  });

  return template;
}

/**
 * Resolve the test-drawer payload template for a trigger.
 *
 * Prefer `trigger.exampleOutput` (authored per-trigger, realistic nested
 * payloads including e.g. `payload.role`/`payload.content` for message
 * triggers). Fall back to the key-name heuristic when the trigger lacks
 * `exampleOutput` — which happens for pipelines persisted before ABLP-564.
 *
 * Strips `tenantId`/`projectId` because those are injected server-side
 * from the user's auth context, not re-sent in the test payload.
 */
function buildPayloadForTrigger(trigger: PipelineTestTrigger | null): Record<string, unknown> {
  if (!trigger) return {};
  const example = trigger.exampleOutput;
  if (example && typeof example === 'object') {
    const copy = structuredClone(example);
    delete copy.tenantId;
    delete copy.projectId;
    return copy;
  }
  return buildTemplateFromInputSchema(trigger.inputSchema);
}

function mapSubmitError(error: unknown, t: TranslationFn): string | string[] {
  const statusCode =
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? ((error as { statusCode: number }).statusCode ?? undefined)
      : undefined;

  switch (statusCode) {
    case 400:
      return t('test.error_validation');
    case 403:
      return t('test.error_forbidden');
    case 404:
      return t('test.error_not_found');
    case 409:
      return t('test.error_trigger_not_active');
    case 413:
      return t('test.error_payload_too_large');
    case 429:
      return t('test.error_rate_limited');
    default:
      return sanitizeErrors(error, t('test.error_submit_failed'));
  }
}

export function PipelineTestDrawer({
  open,
  onClose,
  projectId,
  pipelineId,
  triggers,
  onRunCreated,
}: PipelineTestDrawerProps) {
  const t = useTranslations('pipelines');
  const [selectedTriggerId, setSelectedTriggerId] = useState('');
  const [inputText, setInputText] = useState('{}');
  const [inputError, setInputError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | string[] | null>(null);
  const [running, setRunning] = useState(false);

  const selectableTriggers = useMemo(() => {
    const hasExplicitActiveState = triggers.some((trigger) => typeof trigger.active === 'boolean');
    const source = hasExplicitActiveState ? triggers.filter((trigger) => trigger.active) : triggers;
    return source;
  }, [triggers]);

  const triggerOptions = useMemo(
    () =>
      selectableTriggers.map((trigger) => ({
        value: trigger.id,
        label: trigger.label,
      })),
    [selectableTriggers],
  );

  const selectedTrigger = useMemo(
    () => selectableTriggers.find((trigger) => trigger.id === selectedTriggerId) ?? null,
    [selectableTriggers, selectedTriggerId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const nextTriggerId = selectableTriggers[0]?.id ?? '';
    setSelectedTriggerId(nextTriggerId);
    setInputText(JSON.stringify(buildPayloadForTrigger(selectableTriggers[0] ?? null), null, 2));
    setInputError(undefined);
    setSubmitError(null);
    setRunning(false);
  }, [open, selectableTriggers]);

  useEffect(() => {
    if (!open || !selectedTrigger) {
      return;
    }

    setInputText(JSON.stringify(buildPayloadForTrigger(selectedTrigger), null, 2));
    setInputError(undefined);
    setSubmitError(null);
  }, [open, selectedTrigger]);

  const handleUseTemplate = () => {
    setInputText(JSON.stringify(buildPayloadForTrigger(selectedTrigger), null, 2));
    setInputError(undefined);
  };

  const handleRunTest = async () => {
    if (!selectedTrigger) {
      setSubmitError(t('test.error_not_found'));
      return;
    }

    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(inputText) as Record<string, unknown>;
      if (parsedInput === null || Array.isArray(parsedInput) || typeof parsedInput !== 'object') {
        setInputError(t('test.error_invalid_json'));
        return;
      }
    } catch {
      setInputError(t('test.error_invalid_json'));
      return;
    }

    setInputError(undefined);
    setSubmitError(null);
    setRunning(true);

    try {
      const response = await apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          triggerId: selectedTrigger.id,
          data: parsedInput,
        }),
      });

      const result = await handleResponse<{ success: true; runId: string }>(response);
      onClose();
      onRunCreated?.(result.runId);
    } catch (error) {
      setSubmitError(mapSubmitError(error, t));
    } finally {
      setRunning(false);
    }
  };

  return (
    <SlidePanel open={open} onClose={onClose} title={t('test.drawer_title')} width="lg">
      <div className="space-y-5">
        {submitError && <ErrorAlert error={submitError} onDismiss={() => setSubmitError(null)} />}

        <Select
          label={t('test.trigger_label')}
          options={triggerOptions}
          value={selectedTriggerId}
          onChange={setSelectedTriggerId}
          placeholder={t('test.trigger_label')}
          disabled={triggerOptions.length === 0 || running}
        />

        <Textarea
          label={t('test.input_label')}
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          error={inputError}
          rows={16}
          spellCheck={false}
          className="font-mono text-xs"
        />

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleUseTemplate}
            disabled={!selectedTrigger || running}
          >
            {t('test.use_template')}
          </Button>

          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={running}>
              {t('test.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleRunTest}
              loading={running}
              disabled={!selectedTrigger}
            >
              {t('test.run_test')}
            </Button>
          </div>
        </div>
      </div>
    </SlidePanel>
  );
}
