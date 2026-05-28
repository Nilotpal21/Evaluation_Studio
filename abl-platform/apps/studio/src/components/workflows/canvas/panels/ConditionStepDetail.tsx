'use client';

import { clsx } from 'clsx';

// =============================================================================
// Types
// =============================================================================

interface ExpressionTrace {
  expression: string;
  resolvedValue: unknown;
}

interface EvaluatedCondition {
  id: string;
  expression: string;
  result: boolean;
  traces: ExpressionTrace[];
}

interface ConditionStepDetailProps {
  output?: {
    conditionMet?: boolean;
    expression?: string;
    traces?: ExpressionTrace[];
    branchTaken?: string;
    evaluatedConditions?: EvaluatedCondition[];
  };
}

// =============================================================================
// Helpers
// =============================================================================

function formatBranchLabel(branchTaken: string): string {
  if (branchTaken === 'then') return 'IF branch';
  if (branchTaken === 'else') return 'ELSE branch';
  return `${branchTaken.replace(/^if_/, 'IF #').replace(/^condition_/, 'Condition #')} branch`;
}

function TraceList({ traces }: { traces: ExpressionTrace[] }) {
  return (
    <div className="space-y-1">
      {traces.map((trace, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted truncate max-w-[140px]">{trace.expression}</span>
          <span className="text-muted shrink-0">=</span>
          <span className="font-mono text-foreground-muted truncate">
            {typeof trace.resolvedValue === 'object'
              ? JSON.stringify(trace.resolvedValue)
              : String(trace.resolvedValue ?? 'undefined')}
          </span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function ConditionStepDetail({ output }: ConditionStepDetailProps) {
  if (!output) return null;

  const { conditionMet, expression, traces, branchTaken, evaluatedConditions } = output;

  // Multi-condition else: show all evaluated conditions so user can see why none matched
  if (evaluatedConditions && evaluatedConditions.length > 0 && branchTaken === 'else') {
    return (
      <div className="space-y-3">
        {evaluatedConditions.map((cond, i) => (
          <div
            key={cond.id}
            className="space-y-1.5 rounded-md border border-default bg-background px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {i === 0 ? 'If' : 'Else If'}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-medium px-1.5 py-0.5 rounded',
                  'bg-warning/10 text-warning',
                )}
              >
                false
              </span>
            </div>
            <p className="text-xs font-mono text-foreground-muted break-all">{cond.expression}</p>
            {cond.traces.length > 0 && <TraceList traces={cond.traces} />}
          </div>
        ))}

        {/* Result */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">Result:</span>
          <span className="font-medium px-1.5 py-0.5 rounded bg-warning/10 text-warning">
            false
          </span>
          <span className="text-muted">&rarr;</span>
          <span className="font-medium text-foreground-muted">ELSE branch</span>
        </div>
      </div>
    );
  }

  // Single match (If/Else If matched) or legacy single-expression mode
  return (
    <div className="space-y-2">
      {/* Expression */}
      {expression && (
        <div className="rounded-md border border-default bg-background px-3 py-2">
          <p className="text-xs font-mono text-foreground-muted break-all">{expression}</p>
        </div>
      )}

      {/* Resolution traces */}
      {traces && traces.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Resolved Values
          </p>
          <TraceList traces={traces} />
        </div>
      )}

      {/* Result */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Result:</span>
        <span
          className={clsx(
            'font-medium px-1.5 py-0.5 rounded',
            conditionMet ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
          )}
        >
          {conditionMet ? 'true' : 'false'}
        </span>
        {branchTaken && (
          <>
            <span className="text-muted">&rarr;</span>
            <span className="font-medium text-foreground-muted">
              {formatBranchLabel(branchTaken)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
