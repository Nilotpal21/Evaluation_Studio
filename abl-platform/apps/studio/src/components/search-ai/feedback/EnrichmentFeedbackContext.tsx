/**
 * EnrichmentFeedbackContext
 *
 * React context that provides `showFeedbackToast` to any child component
 * within the Intelligence section. Wrap IntelligenceSection children
 * with <EnrichmentFeedbackProvider> so that enrichment tabs (Fields,
 * Vocabulary, KG) can trigger a toast suggesting "Test in Search & Test".
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useEnrichmentFeedback } from './useEnrichmentFeedback';

interface EnrichmentFeedbackContextValue {
  showFeedbackToast: (message: string) => void;
}

const FeedbackContext = createContext<EnrichmentFeedbackContextValue | null>(null);

export function EnrichmentFeedbackProvider({ children }: { children: ReactNode }) {
  const { showFeedbackToast } = useEnrichmentFeedback();
  const value = useMemo(() => ({ showFeedbackToast }), [showFeedbackToast]);

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

/**
 * useFeedbackToast — call from any child of EnrichmentFeedbackProvider
 * to trigger the enrichment success toast.
 */
export function useFeedbackToast(): EnrichmentFeedbackContextValue {
  const ctx = useContext(FeedbackContext);
  if (!ctx) {
    throw new Error('useFeedbackToast must be used within <EnrichmentFeedbackProvider>');
  }
  return ctx;
}
