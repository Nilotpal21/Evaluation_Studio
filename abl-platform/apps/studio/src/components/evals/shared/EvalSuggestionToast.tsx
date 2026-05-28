/**
 * Eval suggestion toast — shown after Architect applies agent modifications
 * when the project has eval sets configured.
 */

import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';

/**
 * Show an eval re-run suggestion toast if the project has eval sets.
 * Call this after Architect successfully modifies an agent.
 */
export async function showEvalSuggestionIfNeeded(
  projectId: string,
  navigateToEvals: () => void,
): Promise<void> {
  try {
    const res = await apiFetch(`/api/projects/${projectId}/evals/sets`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.sets || data.sets.length === 0) return;

    toast('Agent modified — re-run evals to check for regressions?', {
      action: {
        label: 'Run Evals',
        onClick: navigateToEvals,
      },
      duration: 8000,
    });
  } catch {
    // Silently ignore — eval suggestion is non-critical
  }
}
