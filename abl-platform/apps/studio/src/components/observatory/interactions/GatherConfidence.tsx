/**
 * GatherConfidence — Enhanced gather with per-field confidence bars.
 *
 * Design spec Section 10.2.5. Shows each gathered field with:
 * - Field name + extracted value
 * - Confidence bar (uses ConfidenceBar from Plan 2)
 * - Source text highlighting
 * - Overall stats footer
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { ConfidenceBar } from './ConfidenceBar';
import type { InteractionStep } from './types';

interface GatheredField {
  name: string;
  value: string | null;
  confidence: number | null;
  status: 'filled' | 'pending';
  sourceText?: string;
}

interface GatherConfidenceProps {
  step: InteractionStep;
}

export function GatherConfidence({ step }: GatherConfidenceProps) {
  const styles = getIntentStyles('info');

  const { fields, stats } = useMemo(() => extractGatherFields(step), [step]);

  if (fields.length === 0) {
    const skipped = step.data.skipped === true;
    const mode = step.data.mode as string | undefined;
    const stepName = step.data.stepName as string | undefined;
    const skipReason = step.data.skipReason as string | undefined;

    return (
      <div className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}>
        <div className="flex items-center gap-2">
          {skipped ? (
            <>
              <span className="text-foreground-muted">Gather skipped</span>
              {skipReason && (
                <span className="text-[9px] text-foreground-subtle">
                  — {skipReason.replace(/_/g, ' ')}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-foreground-muted">
                {stepName ? `Gather — ${stepName}` : 'Gather — awaiting input'}
              </span>
              {mode && (
                <span className="text-[9px] text-foreground-subtle">
                  ({mode.replace(/_/g, ' ')})
                </span>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-border-muted">
        <span className={clsx('font-medium', styles.text)}>GATHER — Field-by-field extraction</span>
      </div>

      {/* Fields */}
      <div className="px-3 py-1.5 space-y-2">
        {fields.map((field) => (
          <div key={field.name} className="space-y-0.5">
            <div className="flex items-center gap-2">
              {/* Status icon */}
              <span
                className={field.status === 'filled' ? 'text-success' : 'text-foreground-subtle'}
              >
                {field.status === 'filled' ? '✅' : '⬜'}
              </span>

              {/* Field name */}
              <span className="font-mono text-foreground-muted w-24 truncate shrink-0">
                {field.name}
              </span>

              {/* Value */}
              <span
                className={clsx(
                  'font-mono truncate',
                  field.status === 'filled' ? 'text-foreground' : 'text-foreground-subtle italic',
                )}
              >
                {field.value ? `"${field.value}"` : 'pending — will ask user'}
              </span>

              {/* Confidence bar */}
              {field.confidence != null && (
                <ConfidenceBar
                  value={field.confidence}
                  intent={
                    field.confidence >= 0.8
                      ? 'success'
                      : field.confidence >= 0.5
                        ? 'warning'
                        : 'error'
                  }
                  className="w-24 shrink-0"
                />
              )}
            </div>

            {/* Source text highlight */}
            {field.sourceText ? (
              <div className="ml-7 text-[9px] text-foreground-subtle italic">
                &ldquo;{field.sourceText}&rdquo;
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Stats footer */}
      <div className="px-3 py-1.5 border-t border-border-muted text-[9px] text-foreground-subtle flex items-center gap-2">
        <span>
          {stats.filled}/{stats.total} fields
        </span>
        {stats.overallConfidence != null ? (
          <>
            <span>·</span>
            <span>Overall confidence: {stats.overallConfidence.toFixed(2)}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function extractGatherFields(step: InteractionStep): {
  fields: GatheredField[];
  stats: { filled: number; total: number; overallConfidence: number | null };
} {
  const fields: GatheredField[] = [];

  // Check step data for structured fields (pre-structured format)
  const rawFields = step.data.fields as
    | Array<string | { name: string; value?: unknown; confidence?: number; sourceText?: string }>
    | Record<string, { value?: unknown; confidence?: number; sourceText?: string }>
    | undefined;

  const values = (step.data.extractedValues ?? {}) as Record<string, unknown>;
  const extractedFieldNames = (step.data.extractedFields ?? []) as string[];
  const missingFieldNames = (step.data.missingFields ?? []) as string[];
  const requestedFieldNames = (step.data.requestedFields ?? []) as string[];

  // Build from requestedFields + values (runtime entity_extraction format)
  if (requestedFieldNames.length > 0) {
    for (const name of requestedFieldNames) {
      const value = values[name];
      const isFilled = extractedFieldNames.includes(name) || value != null;
      fields.push({
        name,
        value: value != null ? String(value) : null,
        confidence: null,
        status: isFilled ? 'filled' : 'pending',
      });
    }
  }

  // Build from dsl_collect fields (string[]) + extracted values
  if (fields.length === 0 && Array.isArray(rawFields)) {
    for (const f of rawFields) {
      if (typeof f === 'string') {
        const value = values[f];
        fields.push({
          name: f,
          value: value != null ? String(value) : null,
          confidence: null,
          status: value != null ? 'filled' : 'pending',
        });
      } else {
        fields.push({
          name: f.name,
          value: f.value != null ? String(f.value) : null,
          confidence: typeof f.confidence === 'number' ? f.confidence : null,
          status: f.value != null ? 'filled' : 'pending',
          sourceText: typeof f.sourceText === 'string' ? f.sourceText : undefined,
        });
      }
    }
  } else if (
    fields.length === 0 &&
    rawFields &&
    typeof rawFields === 'object' &&
    !Array.isArray(rawFields)
  ) {
    for (const [name, info] of Object.entries(rawFields)) {
      fields.push({
        name,
        value: info.value != null ? String(info.value) : null,
        confidence: typeof info.confidence === 'number' ? info.confidence : null,
        status: info.value != null ? 'filled' : 'pending',
        sourceText: typeof info.sourceText === 'string' ? info.sourceText : undefined,
      });
    }
  }

  // Fallback: check events for extraction data
  if (fields.length === 0) {
    for (const event of step.events) {
      const extracted = (event.data.extractedValues ??
        event.data.values ??
        event.data.extracted) as Record<string, unknown> | undefined;
      const evtRequested = (event.data.requestedFields ?? event.data.fields) as
        | string[]
        | undefined;
      const evtMissing = event.data.missingFields as string[] | undefined;

      if (evtRequested && Array.isArray(evtRequested)) {
        for (const name of evtRequested) {
          if (!fields.some((f) => f.name === name)) {
            const value = extracted?.[name];
            const isMissing = evtMissing?.includes(name);
            fields.push({
              name,
              value: value != null ? String(value) : null,
              confidence: null,
              status: value != null && !isMissing ? 'filled' : 'pending',
            });
          }
        }
      } else if (extracted) {
        for (const [name, value] of Object.entries(extracted)) {
          if (!fields.some((f) => f.name === name)) {
            fields.push({
              name,
              value: value != null ? String(value) : null,
              confidence: null,
              status: value != null ? 'filled' : 'pending',
            });
          }
        }
      }
    }
  }

  // Add missing fields that aren't already listed
  for (const name of missingFieldNames) {
    if (!fields.some((f) => f.name === name)) {
      fields.push({ name, value: null, confidence: null, status: 'pending' });
    }
  }

  const filled = fields.filter((f) => f.status === 'filled').length;
  const confidences = fields.filter((f) => f.confidence != null).map((f) => f.confidence!);
  const overallConfidence =
    confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;

  return {
    fields,
    stats: { filled, total: fields.length, overallConfidence },
  };
}
