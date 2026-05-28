/**
 * SetupGuide Component
 *
 * Two-card layout for brand new knowledge bases (0 sources, 0 documents):
 * - Left card: File upload drop zone (drag-and-drop, zero navigation)
 * - Right card: Connect a data source (navigates to Data tab with auto-open)
 *
 * Below: "What happens automatically" explainer + LLM warning if not configured.
 *
 * Pipeline step removed (#69): searchIndexId is always set at KB creation
 * and a default pipeline is auto-seeded — the step was always "done".
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Rocket, Plug, AlertTriangle, CheckCircle2 } from 'lucide-react';
import useSWR from 'swr';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';
import { getIndex } from '../../../api/search-ai';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
import { FileDropZone } from './FileDropZone';
import { AddSourceButton } from '../data/AddSourceButton';

interface SetupGuideProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources: SearchAISource[];
  onRefreshSources: () => void;
  onNavigate?: (tab: string, subSection?: string) => void;
  /** Called when user drops/selects files — parent opens FileUploadDialog */
  onFilesSelected: (files: File[]) => void;
  /** True while auto-creating a manual source for the dropped files */
  creatingSource?: boolean;
}

export function SetupGuide({
  knowledgeBase,
  indexId,
  sources,
  onRefreshSources,
  onNavigate,
  onFilesSelected,
  creatingSource = false,
}: SetupGuideProps) {
  const t = useTranslations('search_ai.setup');
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

  // LLM config check — reuse index data to see if LLM is configured
  const { data: indexData } = useSWR(indexId ? [`/indexes/${indexId}`, indexId] : null, () =>
    getIndex(indexId),
  );

  // Use the tenant's DEFAULT model (the one with the star in Model Library).
  // This is the exact model the user chose — no tier-based selection which
  // varies per use case and could show a different model (e.g., gpt-4o-mini
  // for a "fast" tier use case when the user's default is gpt-4o).
  const connectedModelName = indexData?.defaultModel?.displayName ?? null;

  // Fallback: if defaultModel not available (backend not restarted), check enhanced config.
  // Priority: balanced tier (the default) → any active use case → legacy balanced → any legacy.
  const fallbackModelName = (() => {
    if (connectedModelName) return connectedModelName;

    const enhancedLLM = indexData?.enhancedLLMConfig as Record<string, unknown> | null | undefined;
    const enhancedUseCases = enhancedLLM?.useCases as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (enhancedUseCases) {
      // Prefer balanced tier use case (matches the tenant's default model tier)
      const entries = Object.values(enhancedUseCases);
      const balanced = entries.find(
        (uc) =>
          (uc.status === 'active' || uc.status === 'fallback') &&
          uc.modelTier === 'balanced' &&
          (uc.model as Record<string, unknown> | undefined)?.displayName,
      );
      if (balanced) return (balanced.model as Record<string, unknown>).displayName as string;
      // Fall back to any active
      for (const uc of entries) {
        if (uc.status === 'active' || uc.status === 'fallback') {
          const model = uc.model as Record<string, unknown> | undefined;
          if (model?.displayName) return model.displayName as string;
        }
      }
      return null;
    }

    // Legacy fallback — prefer balanced tier model
    const resolvedLLM = indexData?.resolvedLLMConfig as Record<string, unknown> | null | undefined;
    if (!resolvedLLM) return null;
    const useCases = resolvedLLM.useCases as Record<string, Record<string, unknown>> | undefined;
    if (useCases) {
      // Find a balanced tier use case first (e.g., vision → gpt-4o, not progressiveSummarization → gpt-4o-mini)
      const ucEntries = Object.values(useCases);
      const balancedUc = ucEntries.find(
        (uc) => uc.enabled && uc.model && uc.modelTier === 'balanced',
      );
      if (balancedUc) return balancedUc.model as string;
      // Any enabled
      for (const uc of ucEntries) {
        if (uc.enabled && uc.model) return uc.model as string;
      }
    }
    return null;
  })();

  const displayModelName = connectedModelName ?? fallbackModelName;
  const hasLLMConfig = Boolean(displayModelName);

  const [showAddSourceDialog, setShowAddSourceDialog] = useState(false);

  const handleConnectSource = useCallback(() => {
    setShowAddSourceDialog(true);
  }, []);

  const handleSourceAdded = useCallback(
    (source?: { _id: string; name: string; sourceType: string }) => {
      setShowAddSourceDialog(false);
      if (source?.sourceType === 'sharepoint') {
        // SharePoint: panel opens via store, navigate to sources view
        setPendingFilter({ view: 'sources' });
        onNavigate?.('data');
      } else if (source) {
        setPendingFilter({ view: 'documents' });
        onNavigate?.('data');
      }
      onRefreshSources();
    },
    [setPendingFilter, onNavigate, onRefreshSources],
  );

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <Card hoverable={false} padding="lg" className="bg-accent/5 border-accent/20">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-accent/10 p-2.5">
              <Rocket className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('get_started', { name: knowledgeBase.name })}
              </h3>
              <p className="text-sm text-muted mt-1">{t('get_started_description')}</p>
            </div>
          </div>
        </Card>

        {/* Two-card layout: Upload + Connect */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Upload files card */}
          <Card hoverable={false} padding="lg">
            <h4 className="text-sm font-semibold text-foreground mb-3">{t('card_upload_title')}</h4>
            <p className="text-xs text-muted mb-4">{t('card_upload_description')}</p>
            <FileDropZone onFilesSelected={onFilesSelected} disabled={creatingSource} />
          </Card>

          {/* Connect data source card */}
          <Card hoverable={false} padding="lg">
            <div className="flex flex-col h-full">
              <h4 className="text-sm font-semibold text-foreground mb-3">
                {t('card_connect_title')}
              </h4>
              <p className="text-xs text-muted mb-4 flex-1">{t('card_connect_description')}</p>
              <Button
                variant="secondary"
                icon={<Plug className="w-4 h-4" />}
                onClick={handleConnectSource}
              >
                {t('card_connect_action')}
              </Button>
            </div>
          </Card>
        </div>

        {/* What happens automatically */}
        <Card hoverable={false} padding="md" className="bg-background-muted">
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            {t('auto_pipeline_title')}
          </h4>
          <ul className="space-y-1.5 text-xs text-muted">
            <li>{t('auto_pipeline_step_schema')}</li>
            <li>{t('auto_pipeline_step_processing')}</li>
            <li>{t('auto_pipeline_step_search')}</li>
          </ul>
        </Card>

        {/* LLM status banner */}
        {indexId &&
          (hasLLMConfig ? (
            <div className="flex items-center gap-3 rounded-lg border border-success bg-success-subtle px-4 py-3">
              <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
              <p className="text-sm text-foreground flex-1">
                {displayModelName
                  ? t('llm_connected_with_model', { model: displayModelName })
                  : t('llm_connected')}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-warning bg-warning-subtle px-4 py-3">
              <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0" />
              <p className="text-sm text-foreground flex-1">{t('llm_not_configured')}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onNavigate?.('intelligence', 'llm-models')}
              >
                {t('configure_llm')}
              </Button>
            </div>
          ))}
      </div>

      {/* Add source dialog — opens on Home tab, no tab switch */}
      <AddSourceButton
        indexId={indexId}
        onSourceAdded={handleSourceAdded}
        dialogOnly
        open={showAddSourceDialog}
        onClose={() => setShowAddSourceDialog(false)}
      />
    </>
  );
}
