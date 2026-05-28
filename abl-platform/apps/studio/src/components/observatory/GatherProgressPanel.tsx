'use client';

/**
 * Gather Progress Panel
 *
 * Shows field collection status with visual progress.
 * Displays both:
 * - Expected gather fields from agent IR
 * - Received context data (from handoffs, previous agents, etc.)
 */

import { useMemo } from 'react';
import { useSessionStore } from '../../store/session-store';
import { CheckCircle, Circle, Loader2, AlertCircle, ArrowRight, Database } from 'lucide-react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';

interface GatherField {
  name: string;
  value: unknown;
  status: 'collected' | 'pending' | 'not_started' | 'error';
  type?: string;
  source?: 'gather' | 'context' | 'handoff';
}

export function GatherProgressPanel() {
  const t = useTranslations('observatory.gather');
  const state = useSessionStore((s) => s.state);
  const agent = useSessionStore((s) => s.agent);

  // Use the active child agent's IR if available (set during handoff),
  // otherwise fall back to the loaded agent's IR
  const activeAgentIR = state?.activeAgent?.ir;
  const activeAgentName = state?.activeAgent?.name;
  const rawIR = activeAgentIR || agent?.ir;

  // Get gather config from agent IR
  const ir = rawIR as
    | {
        gather?: {
          fields?: Array<{ name: string; type?: string; required?: boolean }>;
        };
        flow?: {
          definitions?: Record<
            string,
            {
              gather?: { fields?: Array<{ name: string; type?: string; required?: boolean }> };
              collect?: string[];
            }
          >;
        };
      }
    | undefined;

  // Memoize expensive field computation from IR + state
  const { gatherFields, contextFields } = useMemo(() => {
    const addedFieldNames = new Set<string>();
    const gatherResult: GatherField[] = [];

    // From top-level gather
    if (ir?.gather?.fields) {
      for (const field of ir.gather.fields) {
        const value = state?.gatherProgress?.[field.name] ?? state?.context?.[field.name];
        gatherResult.push({
          name: field.name,
          value,
          status:
            value !== undefined && value !== null && value !== ''
              ? 'collected'
              : state?.flowState?.currentStep
                ? 'not_started'
                : 'not_started',
          type: field.type,
          source: 'gather',
        });
        addedFieldNames.add(field.name);
      }
    }

    // From flow step gather/collect
    if (ir?.flow?.definitions) {
      for (const [stepName, step] of Object.entries(ir.flow.definitions)) {
        if (step.gather?.fields) {
          for (const field of step.gather.fields) {
            if (!addedFieldNames.has(field.name)) {
              const value = state?.gatherProgress?.[field.name] ?? state?.context?.[field.name];
              const isCurrentStep = state?.flowState?.currentStep === stepName;
              gatherResult.push({
                name: field.name,
                value,
                status:
                  value !== undefined && value !== null && value !== ''
                    ? 'collected'
                    : isCurrentStep
                      ? 'pending'
                      : 'not_started',
                type: field.type,
                source: 'gather',
              });
              addedFieldNames.add(field.name);
            }
          }
        }
        if (step.collect) {
          for (const fieldName of step.collect) {
            if (!addedFieldNames.has(fieldName)) {
              const value = state?.gatherProgress?.[fieldName] ?? state?.context?.[fieldName];
              const isCurrentStep = state?.flowState?.currentStep === stepName;
              gatherResult.push({
                name: fieldName,
                value,
                status:
                  value !== undefined && value !== null && value !== ''
                    ? 'collected'
                    : isCurrentStep
                      ? 'pending'
                      : 'not_started',
                source: 'gather',
              });
              addedFieldNames.add(fieldName);
            }
          }
        }
      }
    }

    // Context data not in gather fields (from handoffs, etc.)
    const contextResult: GatherField[] = [];

    if (state?.gatherProgress) {
      for (const [key, value] of Object.entries(state.gatherProgress)) {
        if (!addedFieldNames.has(key) && value !== undefined && value !== null && value !== '') {
          contextResult.push({
            name: key,
            value,
            status: 'collected',
            source: 'context',
          });
          addedFieldNames.add(key);
        }
      }
    }

    if (state?.context) {
      for (const [key, value] of Object.entries(state.context)) {
        if (!addedFieldNames.has(key) && value !== undefined && value !== null && value !== '') {
          if (
            key.startsWith('_') ||
            key === 'conversationPhase' ||
            key === 'handoff_from' ||
            key === 'activeAgent'
          )
            continue;

          contextResult.push({
            name: key,
            value,
            status: 'collected',
            source: 'handoff',
          });
          addedFieldNames.add(key);
        }
      }
    }

    return { gatherFields: gatherResult, contextFields: contextResult };
  }, [ir, state?.gatherProgress, state?.context, state?.flowState?.currentStep]);

  // Calculate progress for gather fields only
  const collectedCount = gatherFields.filter((f) => f.status === 'collected').length;
  const totalCount = gatherFields.length;
  const progressPercent = totalCount > 0 ? Math.round((collectedCount / totalCount) * 100) : 0;

  const hasGatherFields = gatherFields.length > 0;
  const hasContextData = contextFields.length > 0;

  if (!hasGatherFields && !hasContextData) {
    return (
      <div className="p-3 text-subtle text-sm">
        <div className="flex items-center gap-2 mb-2">
          <Database className="w-4 h-4" />
          <span>{t('no_data_title')}</span>
        </div>
        <p className="text-xs">{t('no_data_hint')}</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-4 h-full overflow-y-auto">
      {/* Gather Fields Section */}
      {hasGatherFields && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {activeAgentName
                ? t('agent_fields', { agentName: activeAgentName })
                : t('expected_fields')}
            </span>
            <span className="text-xs text-subtle">
              {collectedCount}/{totalCount}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-1.5 bg-background-elevated rounded-full overflow-hidden">
            <div
              className={clsx(
                'h-full transition-all duration-300',
                progressPercent === 100 ? 'bg-success' : 'bg-accent',
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Field List */}
          <div className="space-y-1">
            {gatherFields.map((field) => (
              <FieldItem key={field.name} field={field} />
            ))}
          </div>
        </div>
      )}

      {/* Context/Handoff Data Section */}
      {hasContextData && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ArrowRight className="w-3.5 h-3.5 text-info" />
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('received_data')}
            </span>
            <span className="text-xs text-info opacity-60">{t('from_handoffs')}</span>
          </div>

          {/* Context Field List */}
          <div className="space-y-1">
            {contextFields.map((field) => (
              <FieldItem key={field.name} field={field} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldItem({ field }: { field: GatherField }) {
  const t = useTranslations('observatory.gather');
  return (
    <div
      className={clsx(
        'flex items-start gap-2 p-2 rounded text-sm',
        field.status === 'collected' && field.source === 'handoff' && 'bg-info-subtle',
        field.status === 'collected' && field.source !== 'handoff' && 'bg-success-subtle',
        field.status === 'pending' && 'bg-accent-subtle',
        field.status === 'not_started' && 'bg-background-muted',
        field.status === 'error' && 'bg-error-subtle',
      )}
    >
      {/* Status Icon */}
      <div className="mt-0.5">
        {field.status === 'collected' && field.source === 'handoff' && (
          <ArrowRight className="w-4 h-4 text-info" />
        )}
        {field.status === 'collected' && field.source !== 'handoff' && (
          <CheckCircle className="w-4 h-4 text-success" />
        )}
        {field.status === 'pending' && <Loader2 className="w-4 h-4 text-accent animate-spin" />}
        {field.status === 'not_started' && <Circle className="w-4 h-4 text-subtle" />}
        {field.status === 'error' && <AlertCircle className="w-4 h-4 text-error" />}
      </div>

      {/* Field Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={clsx(
              'font-medium',
              field.status === 'collected' && field.source === 'handoff'
                ? 'text-info'
                : field.status === 'collected'
                  ? 'text-success'
                  : field.status === 'pending'
                    ? 'text-accent'
                    : field.status === 'error'
                      ? 'text-error'
                      : 'text-muted',
            )}
          >
            {field.name}
          </span>
          {field.type && (
            <span className="text-xs text-subtle bg-background-elevated px-1.5 py-0.5 rounded">
              {field.type}
            </span>
          )}
          {field.source === 'handoff' && (
            <span className="text-xs text-info bg-info-subtle px-1.5 py-0.5 rounded">
              {t('handoff_label')}
            </span>
          )}
        </div>
        {field.status === 'collected' && field.value !== undefined && (
          <div className="text-xs text-muted mt-0.5 break-all">{formatValue(field.value)}</div>
        )}
        {field.status === 'pending' && (
          <div className="text-xs text-accent mt-0.5">{t('waiting_for_input')}</div>
        )}
      </div>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    return value.length > 100 ? value.slice(0, 100) + '...' : value;
  }
  if (typeof value === 'object') {
    const str = JSON.stringify(value);
    return str.length > 100 ? str.slice(0, 100) + '...' : str;
  }
  return String(value);
}

export default GatherProgressPanel;
