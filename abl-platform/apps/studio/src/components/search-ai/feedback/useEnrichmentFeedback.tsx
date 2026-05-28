/**
 * useEnrichmentFeedback
 *
 * Hook that provides `showFeedbackToast(message)` for enrichment actions.
 * Uses sonner's `toast.custom()` to render the EnrichmentFeedbackToast
 * with a 5-second auto-dismiss.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';

import { EnrichmentFeedbackToast } from './EnrichmentFeedbackToast';

const TOAST_DURATION_MS = 5000;

export function useEnrichmentFeedback() {
  const showFeedbackToast = useCallback((message: string) => {
    toast.custom(
      (id) => <EnrichmentFeedbackToast message={message} onDismiss={() => toast.dismiss(id)} />,
      { duration: TOAST_DURATION_MS },
    );
  }, []);

  return { showFeedbackToast };
}
