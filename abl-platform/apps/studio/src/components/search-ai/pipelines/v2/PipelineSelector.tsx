/**
 * PipelineSelector — Dropdown for switching between pipelines.
 *
 * In single-pipeline mode, shows the current pipeline name + status badge,
 * with options to view the Default Pipeline or create a new one.
 */

'use client';

import { useState, useCallback } from 'react';
import { ChevronDown, Plus, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '../../../ui/Badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../../../ui/DropdownMenu';
import { usePipelineStore } from '../../../../store/pipeline-store';
import type { PipelineDefinition } from '../../../../api/pipelines';
import { CreatePipelineModal, type PipelineTemplate } from './CreatePipelineModal';

export interface PipelineSelectorProps {
  definition: PipelineDefinition | null;
  isLoading: boolean;
  projectId: string;
  knowledgeBaseId: string;
}

export function PipelineSelector({
  definition,
  isLoading,
  projectId,
  knowledgeBaseId,
}: PipelineSelectorProps) {
  const t = useTranslations('search_ai.pipeline');

  const isDefaultView = usePipelineStore((s) => s.isDefaultView);
  const setDefaultView = usePipelineStore((s) => s.setDefaultView);
  const createPipelineAction = usePipelineStore((s) => s.createPipeline);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const handleSelectPipeline = useCallback(() => {
    setDefaultView(false);
  }, [setDefaultView]);

  const handleSelectDefault = useCallback(() => {
    setDefaultView(true);
  }, [setDefaultView]);

  const handleCreateNew = useCallback(() => {
    if (definition) {
      toast(t('v2_selector_only_one'));
      return;
    }
    setCreateModalOpen(true);
  }, [definition, t]);

  const handleCreateConfirm = useCallback(
    (_name: string, _description: string, _template: PipelineTemplate) => {
      setCreateModalOpen(false);
      // TODO: pass name/description/template to the create API when backend supports it
      createPipelineAction(projectId, knowledgeBaseId);
    },
    [createPipelineAction, projectId, knowledgeBaseId],
  );

  const statusBadge = definition ? (
    <Badge variant={definition.status === 'active' ? 'success' : 'default'} dot>
      {definition.status === 'active' ? t('header_status_published') : t('header_status_draft')}
    </Badge>
  ) : null;

  const displayName = isDefaultView
    ? t('v2_selector_default_pipeline')
    : (definition?.name ?? t('v2_loading'));

  return (
    <>
      <DropdownMenu
        align="start"
        trigger={
          <button
            type="button"
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-foreground hover:bg-background-muted transition-default disabled:opacity-50"
          >
            <span>{displayName}</span>
            {!isDefaultView && statusBadge}
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          </button>
        }
      >
        {definition && (
          <DropdownMenuItem
            onSelect={handleSelectPipeline}
            icon={!isDefaultView ? <Check className="w-3.5 h-3.5" /> : <span className="w-3.5" />}
          >
            <span className="flex items-center gap-2">
              {definition.name}
              <Badge variant={definition.status === 'active' ? 'success' : 'default'} dot>
                {definition.status === 'active'
                  ? t('header_status_published')
                  : t('header_status_draft')}
              </Badge>
            </span>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          onSelect={handleSelectDefault}
          icon={isDefaultView ? <Check className="w-3.5 h-3.5" /> : <span className="w-3.5" />}
        >
          {t('v2_selector_default_pipeline')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={handleCreateNew}
          disabled={definition !== null}
          icon={<Plus className="w-3.5 h-3.5" />}
        >
          {t('v2_selector_create_new')}
        </DropdownMenuItem>
      </DropdownMenu>

      <CreatePipelineModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onConfirm={handleCreateConfirm}
      />
    </>
  );
}
