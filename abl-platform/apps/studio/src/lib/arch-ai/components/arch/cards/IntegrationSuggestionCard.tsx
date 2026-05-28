'use client';

import { memo } from 'react';
import { useArchAIStore } from '../../../store/arch-ai-store';

export interface IntegrationSuggestionPayload {
  title: string;
  rationale: string;
  providerOptions: Array<{ name: string; logo?: string; providerKey: string }>;
  targetAgentNames?: string[];
  skipLabel?: string;
}

interface IntegrationSuggestionCardProps {
  event: IntegrationSuggestionPayload;
}

function IntegrationSuggestionCardImpl({ event }: IntegrationSuggestionCardProps) {
  // Task 4.1 will add setPrefillMetadata to the store. Until then, fall back to
  // setPrefillMessage so the card works end-to-end.
  const setPrefillMetadata = useArchAIStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s) => (s as unknown as { setPrefillMetadata?: (m: unknown) => void }).setPrefillMetadata,
  );
  const setPrefillMessage = useArchAIStore((s) => s.setPrefillMessage);

  const handlePick = (providerKey: string) => {
    if (typeof setPrefillMetadata === 'function') {
      setPrefillMetadata({
        kind: 'start_integration',
        providerKey,
        targetAgentNames: event.targetAgentNames,
      });
      return;
    }
    const agents = event.targetAgentNames?.length
      ? ` for ${event.targetAgentNames.join(', ')}`
      : '';
    setPrefillMessage(`Connect ${providerKey}${agents}`);
  };

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <p className="text-sm font-semibold text-foreground">{event.title}</p>
      <p className="mt-1 text-xs text-foreground-muted">{event.rationale}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {event.providerOptions.map((p) => (
          <button
            key={p.providerKey}
            type="button"
            onClick={() => handlePick(p.providerKey)}
            className="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export const IntegrationSuggestionCard = memo(IntegrationSuggestionCardImpl);
