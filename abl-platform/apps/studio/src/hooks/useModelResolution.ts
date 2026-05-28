/**
 * useModelResolution Hook
 *
 * Reads trace events from the observatory store and extracts model resolution
 * chain data (session_resolution / model_resolution events). Returns the chain
 * of resolution levels, the resolved model, and the resolved provider.
 */

import { useMemo } from 'react';
import { useObservatoryStore } from '../store/observatory-store';

export interface ChainStep {
  level: number;
  name: string;
  /** Whether this level was checked during resolution */
  checked: boolean;
  /** Whether a match was found at this level */
  matched: boolean;
  /** The value found at this level (model identifier) */
  value?: string;
  /** Human-readable reason or note */
  reason?: string;
}

export interface ModelResolutionResult {
  chain: ChainStep[] | null;
  resolvedModel?: string;
  resolvedProvider?: string;
  source?: string;
}

export function useModelResolution(): ModelResolutionResult {
  const events = useObservatoryStore((s) => s.events);

  return useMemo(() => {
    // Look for session_resolution or model_resolution events
    const resolutionEvent = events.find(
      (e) => e.type === 'session_resolution' || (e.type as string) === 'model_resolution',
    );

    if (!resolutionEvent) {
      return { chain: null };
    }

    const data = resolutionEvent.data as Record<string, unknown>;

    // Try to extract chain from event data — support multiple shapes
    const rawChain = (data.chain ?? data.resolutionChain ?? data.steps) as
      | Array<Record<string, unknown>>
      | undefined;

    if (Array.isArray(rawChain) && rawChain.length > 0) {
      const chain: ChainStep[] = rawChain.map((step, idx) => ({
        level: (step.level as number) ?? idx + 1,
        name: (step.name as string) ?? (step.label as string) ?? `Level ${idx + 1}`,
        checked: (step.checked as boolean) ?? true,
        matched: (step.matched as boolean) ?? false,
        value: step.value as string | undefined,
        reason: step.reason as string | undefined,
      }));

      return {
        chain,
        resolvedModel: (data.resolvedModel ?? data.model) as string | undefined,
        resolvedProvider: (data.resolvedProvider ?? data.provider) as string | undefined,
        source: (data.source ?? data.resolvedFrom) as string | undefined,
      };
    }

    // Fallback: if the event has model/provider but no chain, synthesize a minimal result
    const model = (data.resolvedModel ?? data.model) as string | undefined;
    const provider = (data.resolvedProvider ?? data.provider) as string | undefined;

    if (model || provider) {
      return {
        chain: null,
        resolvedModel: model,
        resolvedProvider: provider,
        source: (data.source ?? data.resolvedFrom) as string | undefined,
      };
    }

    return { chain: null };
  }, [events]);
}
