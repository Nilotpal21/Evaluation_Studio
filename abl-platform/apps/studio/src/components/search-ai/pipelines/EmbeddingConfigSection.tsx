/**
 * Embedding Config Section
 *
 * Compact row showing current embedding configuration in the pipeline editor.
 * Renders below the PipelineHeader, above the flows list.
 *
 * Reference: docs/searchai/pipelines/design/frontend/WIREMOCK-EMBEDDING-CONFIGURATION.md
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import { ChangeEmbeddingDialog } from './ChangeEmbeddingDialog';

const PROVIDER_LABELS: Record<string, string> = {
  'bge-m3': 'BGE-M3',
  openai: 'OpenAI',
  cohere: 'Cohere',
  custom: 'Custom',
};

export function EmbeddingConfigSection() {
  const { draft, embeddingDialogOpen, openEmbeddingDialog } = usePipelineStore();
  const t = useTranslations('search_ai.pipeline');

  const HOSTED_LABELS: Record<string, string> = useMemo(
    () => ({
      'bge-m3': t('embed_hosted_self'),
      openai: t('embed_hosted_cloud'),
      cohere: t('embed_hosted_cloud'),
      custom: t('embed_hosted_self'),
    }),
    [t],
  );

  if (!draft) return null;

  const config = draft.activeEmbeddingConfig;
  const provider = config?.provider ?? 'bge-m3';
  const model = config?.model ?? 'bge-m3';
  const dimensions = config?.dimensions ?? 1024;
  const isSelfHosted = provider === 'bge-m3' || provider === 'custom';

  return (
    <>
      <div className="flex items-center justify-between px-6 py-3 border-b border-default bg-background-muted/30">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isSelfHosted ? 'bg-success' : 'bg-accent'}`} />
            <span className="text-sm font-medium text-foreground">
              {PROVIDER_LABELS[provider] ?? provider}
            </span>
          </div>
          <span className="text-xs text-muted">
            {model} | {t('embed_dimensions_count', { count: dimensions })} |{' '}
            {HOSTED_LABELS[provider] ?? t('embed_hosted_unknown')}
          </span>
        </div>

        <button
          className="px-3 py-1 text-xs border border-default rounded-md hover:bg-background-muted text-muted hover:text-foreground transition-colors"
          onClick={() => openEmbeddingDialog()}
          disabled={draft.status === 'archived'}
          title={t('embed_change_button_title')}
        >
          {t('embed_change_button')}
        </button>
      </div>

      {embeddingDialogOpen && <ChangeEmbeddingDialog />}
    </>
  );
}
