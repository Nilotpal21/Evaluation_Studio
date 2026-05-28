import clsx from 'clsx';
import type { InteractionStep } from './types';

interface FlowStepContextLineProps {
  step: InteractionStep;
  className?: string;
}

function getDisplayValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function FlowStepContextLine({ step, className }: FlowStepContextLineProps) {
  const agentName = getDisplayValue(step.agentName) ?? getDisplayValue(step.data.agentName);
  const stepName =
    getDisplayValue(step.flowStepName) ??
    getDisplayValue(step.data.flowStepName) ??
    getDisplayValue(step.data.stepName);
  const stepType =
    getDisplayValue(step.flowStepType) ??
    getDisplayValue(step.data.flowStepType) ??
    getDisplayValue(step.data.stepType);

  if (!stepName && !stepType) {
    return null;
  }

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-foreground-subtle',
        className,
      )}
    >
      {agentName && (
        <span>
          Agent: <span className="font-mono text-foreground">{agentName}</span>
        </span>
      )}
      {stepName && (
        <span>
          Step: <span className="font-mono text-foreground">{stepName}</span>
        </span>
      )}
      {stepType && (
        <span>
          Type: <span className="font-mono text-foreground-muted">{stepType}</span>
        </span>
      )}
    </div>
  );
}
