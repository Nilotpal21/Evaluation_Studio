/**
 * EnrichmentFeedbackToast
 *
 * Custom toast content rendered via sonner's `toast.custom()`.
 * Shows a success message with a "Test in Search & Test" link
 * that navigates to the search tab.
 */

import { X, CheckCircle2, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../../store/navigation-store';

interface EnrichmentFeedbackToastProps {
  message: string;
  onDismiss: () => void;
}

export function EnrichmentFeedbackToast({ message, onDismiss }: EnrichmentFeedbackToastProps) {
  const t = useTranslations('search_ai.feedback');
  const setTab = useNavigationStore((s) => s.setTab);

  const handleNavigateToSearch = () => {
    setTab('search');
    onDismiss();
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-default bg-background-elevated p-4 shadow-lg min-w-[320px] max-w-[420px] animate-in slide-in-from-bottom-5 fade-in duration-300">
      <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{message}</p>
        <button
          type="button"
          onClick={handleNavigateToSearch}
          className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t('test_in_search')}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-muted hover:text-foreground hover:bg-background-muted transition-colors"
        aria-label={t('toast_dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
