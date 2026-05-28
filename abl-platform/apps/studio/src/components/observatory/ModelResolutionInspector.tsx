/**
 * ModelResolutionInspector
 *
 * Displays the model resolution chain as a vertical stepper, showing which
 * resolution level was matched and which were skipped. Reads data from the
 * useModelResolution hook (observatory trace events).
 */

import { CheckCircle2, XCircle, Minus, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { useModelResolution, type ChainStep } from '../../hooks/useModelResolution';

export function ModelResolutionInspector() {
  const { chain, resolvedModel, resolvedProvider, source } = useModelResolution();

  // No resolution data at all
  if (!chain && !resolvedModel) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-subtle text-xs gap-1.5">
        <Cpu className="w-6 h-6 opacity-30" />
        <span>No model resolution data available for this session.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-muted uppercase tracking-wide">
        Model Resolution Chain
      </h3>

      {/* Chain stepper */}
      {chain && chain.length > 0 && (
        <div className="space-y-0.5">
          {chain.map((step) => (
            <ChainStepRow key={step.level} step={step} />
          ))}
        </div>
      )}

      {/* Resolved summary */}
      {(resolvedModel || resolvedProvider) && (
        <div className="mt-3 rounded-lg bg-background-muted px-3 py-2 space-y-1">
          {resolvedModel && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted font-medium">Resolved:</span>
              <span className="font-mono text-foreground">{resolvedModel}</span>
            </div>
          )}
          {resolvedProvider && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted font-medium">Provider:</span>
              <span className="text-foreground">{resolvedProvider}</span>
            </div>
          )}
          {source && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted font-medium">Source:</span>
              <span className="text-foreground">{source}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChainStepRow({ step }: { step: ChainStep }) {
  const icon = step.matched ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
  ) : step.checked ? (
    <XCircle className="w-3.5 h-3.5 text-error shrink-0" />
  ) : (
    <Minus className="w-3.5 h-3.5 text-subtle shrink-0" />
  );

  const statusLabel = step.matched ? '' : step.checked ? 'not found' : 'skipped';

  return (
    <div
      className={clsx(
        'flex items-center gap-2 px-2 py-1.5 rounded text-xs',
        step.matched && 'bg-success-subtle',
      )}
    >
      {icon}
      <span
        className={clsx(
          'font-medium',
          step.matched ? 'text-success' : step.checked ? 'text-error' : 'text-subtle',
        )}
      >
        Level {step.level}:
      </span>
      <span className={clsx(step.matched ? 'text-foreground' : 'text-muted')}>{step.name}</span>
      {step.value && (
        <>
          <span className="text-muted">-&gt;</span>
          <span className="font-mono text-accent">{step.value}</span>
        </>
      )}
      {statusLabel && <span className="text-subtle ml-auto">({statusLabel})</span>}
      {step.reason && (
        <span className="text-subtle ml-1 truncate max-w-[160px]">{step.reason}</span>
      )}
    </div>
  );
}

export default ModelResolutionInspector;
