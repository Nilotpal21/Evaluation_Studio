/**
 * EmptyPipelineState — Shown when no pipeline exists for the knowledge base.
 *
 * Centered message with a "Create Pipeline" action button.
 */

'use client';

import { GitBranchPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '../../../ui/Button';

export interface EmptyPipelineStateProps {
  onCreatePipeline: () => void;
  isCreating: boolean;
}

export function EmptyPipelineState({ onCreatePipeline, isCreating }: EmptyPipelineStateProps) {
  const t = useTranslations('search_ai.pipeline');

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <GitBranchPlus className="h-12 w-12 text-muted" />
      <div className="text-center">
        <h3 className="text-base font-medium text-foreground">{t('v2_editor_empty_title')}</h3>
        <p className="mt-1 max-w-md text-sm text-muted">{t('v2_editor_empty_description')}</p>
      </div>
      <Button
        variant="primary"
        onClick={onCreatePipeline}
        loading={isCreating}
        disabled={isCreating}
      >
        {isCreating ? t('v2_editor_creating') : t('v2_editor_create')}
      </Button>
    </div>
  );
}
