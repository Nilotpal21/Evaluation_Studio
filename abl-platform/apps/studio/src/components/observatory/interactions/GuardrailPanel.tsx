/**
 * GuardrailPanel — Expanded guardrail results with confidence bars.
 *
 * Shows each guardrail check with: name, result badge, confidence bar.
 */

import { useState, useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import { Shield, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { ConfidenceBar } from './ConfidenceBar';
import { FlowStepContextLine } from './FlowStepContextLine';
import type { InteractionStep } from './types';

interface GuardrailPanelProps {
  step: InteractionStep;
  variant: 'input' | 'output';
}

export interface GuardrailCheck {
  name: string;
  result: 'pass' | 'warning' | 'fail' | 'unknown';
  confidence?: number;
  details?: string;
  raw?: Record<string, unknown>;
}

export function GuardrailPanel({ step, variant }: GuardrailPanelProps) {
  const [showRaw, setShowRaw] = useState(false);

  const checks = useMemo(() => extractGuardrailChecks(step), [step]);
  const allPassed = checks.every((c) => c.result === 'pass');
  const hasFailure = checks.some((c) => c.result === 'fail');

  const panelIntent: SemanticIntent = hasFailure ? 'error' : allPassed ? 'success' : 'warning';
  const panelStyles = getIntentStyles(panelIntent);

  const Icon = variant === 'input' ? Shield : ShieldCheck;
  const title =
    variant === 'input' ? 'Input Guardrail — Pre-processing' : 'Output Guardrail — Post-processing';

  return (
    <div
      className={clsx(
        'rounded-md border px-3 py-2 text-xs space-y-2',
        panelStyles.border,
        panelStyles.bgSubtle,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Icon className={clsx('w-3.5 h-3.5', panelStyles.text)} />
        <span className={clsx('font-medium', panelStyles.text)}>{title}</span>
      </div>
      <FlowStepContextLine step={step} />

      {/* Check rows */}
      <div className="space-y-1.5">
        {checks.map((check, i) => (
          <GuardrailCheckRow key={i} check={check} />
        ))}
      </div>

      {/* Raw response toggle */}
      {step.events.length > 0 && (
        <>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="flex items-center gap-1 text-[10px] text-foreground-muted hover:text-foreground transition-colors"
          >
            {showRaw ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            View raw guardrail response
          </button>

          {showRaw && (
            <div className="bg-background-elevated rounded p-2 text-[10px] font-mono text-foreground-muted whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {JSON.stringify(
                step.events.map((e) => e.data),
                null,
                2,
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GuardrailCheckRow({ check }: { check: GuardrailCheck }) {
  const resultIntent: SemanticIntent =
    check.result === 'pass' ? 'success' : check.result === 'fail' ? 'error' : 'warning';

  const resultLabel =
    check.result === 'pass'
      ? 'Clean'
      : check.result === 'fail'
        ? 'Blocked'
        : check.result === 'warning'
          ? 'Warning'
          : 'Unknown';

  const resultStyles = getIntentStyles(resultIntent);

  return (
    <div className="flex items-center gap-2">
      <span className="text-foreground-muted w-28 truncate shrink-0">{check.name}</span>
      <span className={clsx('text-[9px] font-medium shrink-0 w-16', resultStyles.text)}>
        {resultLabel}
      </span>
      {check.confidence != null && (
        <ConfidenceBar value={check.confidence} intent={resultIntent} className="flex-1" />
      )}
    </div>
  );
}

/**
 * Extract and classify guardrail checks from a step's trace events.
 *
 * Parses guardrail-related trace events and extracts individual check results
 * with classification (pass/warning/fail), confidence scores, and details.
 *
 * @param step - Interaction step containing guardrail events
 * @returns Array of classified guardrail checks with results
 *
 * @remarks
 * - Normalizes various result formats (pass/clean/Clean → 'pass')
 * - Extracts confidence scores when available
 * - Falls back to step.data if no events found
 * - Pure function - no side effects, suitable for unit testing
 *
 * @example
 * ```ts
 * const checks = extractGuardrailChecks(inputGuardStep);
 * // Returns: [
 * //   { name: 'pii_scan', result: 'pass', confidence: 0.98 },
 * //   { name: 'prompt_injection', result: 'pass', confidence: 0.99 }
 * // ]
 * ```
 */
export function extractGuardrailChecks(step: InteractionStep): GuardrailCheck[] {
  const checks: GuardrailCheck[] = [];

  for (const event of step.events) {
    const d = event.data;
    const name = String(d.checkType ?? d.guardName ?? d.name ?? event.type).replace(
      /^guardrail_/,
      '',
    );

    let result: GuardrailCheck['result'] = 'unknown';
    if (
      d.result === 'pass' ||
      d.result === 'clean' ||
      d.result === 'Clean' ||
      d.outcome === 'pass'
    ) {
      result = 'pass';
    } else if (
      d.result === 'fail' ||
      d.result === 'blocked' ||
      d.result === 'Blocked' ||
      d.outcome === 'fail'
    ) {
      result = 'fail';
    } else if (d.result === 'warning' || event.type === 'guardrail_warning') {
      result = 'warning';
    } else if (d.result === 'Pass' || d.passed === true) {
      result = 'pass';
    }

    checks.push({
      name,
      result,
      confidence: typeof d.confidence === 'number' ? d.confidence : undefined,
      details:
        typeof d.details === 'string'
          ? d.details
          : typeof d.message === 'string'
            ? d.message
            : undefined,
      raw: d,
    });
  }

  // If no individual events, create a single check from step data
  if (checks.length === 0 && step.data.checkType) {
    checks.push({
      name: String(step.data.checkType),
      result:
        step.data.result === 'pass' || step.data.result === 'clean'
          ? 'pass'
          : step.data.result === 'fail'
            ? 'fail'
            : 'unknown',
      confidence: typeof step.data.confidence === 'number' ? step.data.confidence : undefined,
    });
  }

  return checks;
}
