/**
 * NewFlowModal — Dialog for creating a new pipeline flow.
 * Shows name input, priority, and template selection.
 */

'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { usePipelineStore } from '../../../../store/pipeline-store';
import type { PipelineFlow } from '../../../../api/pipelines';

export interface NewFlowModalProps {
  open: boolean;
  onClose: () => void;
}

export function NewFlowModal({ open, onClose }: NewFlowModalProps) {
  const t = useTranslations('search_ai.pipeline');
  const draft = usePipelineStore((s) => s.draft);
  const addFlow = usePipelineStore((s) => s.addFlow);
  const selectFlow = usePipelineStore((s) => s.selectFlow);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<'empty' | 'copy-default' | 'minimal'>('empty');

  const nextPriority = (draft?.flows.length ?? 0) + 1;

  const handleCreate = useCallback(() => {
    if (!name.trim()) return;

    const flowId = `flow-${crypto.randomUUID()}`;

    // Build stages based on template
    let stages: PipelineFlow['stages'] = [];
    if (template === 'copy-default') {
      const defaultFlow = draft?.flows.find((f) => f.isDefault);
      if (defaultFlow) {
        stages = defaultFlow.stages
          .filter((s) => s.type !== 'embedding')
          .map((s) => ({
            ...s,
            id: `${s.id}-copy-${Date.now()}`,
          }));
      }
    } else if (template === 'minimal') {
      stages = [
        {
          id: `stage-extraction-${Date.now()}`,
          name: 'Document Extraction',
          type: 'extraction',
          provider: 'docling',
          providerConfig: {},
          order: 0,
        },
        {
          id: `stage-chunking-${Date.now()}`,
          name: 'Chunking',
          type: 'chunking',
          provider: 'recursive-character',
          providerConfig: {},
          order: 1,
        },
      ];
    }

    const newFlow: PipelineFlow = {
      id: flowId,
      name: name.trim(),
      description: description.trim() || undefined,
      enabled: true,
      isDefault: false,
      priority: nextPriority,
      stages,
      selectionRules: [],
    };

    addFlow(newFlow);
    selectFlow(flowId);
    setName('');
    setDescription('');
    setTemplate('empty');
    onClose();
  }, [name, template, draft?.flows, nextPriority, addFlow, selectFlow, onClose]);

  const handleClose = useCallback(() => {
    setName('');
    setDescription('');
    setTemplate('empty');
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onClose={handleClose} title={t('v2_new_flow_title')}>
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label className="mb-1 block text-xs font-medium text-foreground-muted">
            {t('v2_new_flow_name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('v2_new_flow_name_placeholder')}
            className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            autoFocus
          />
        </div>

        {/* Description */}
        <div>
          <label className="mb-1 block text-xs font-medium text-foreground-muted">
            {t('v2_new_flow_description')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('v2_new_flow_description_placeholder')}
            rows={2}
            className="w-full resize-none rounded-md border border-default bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Template */}
        <div>
          <label className="mb-2 block text-xs font-medium text-foreground-muted">
            {t('v2_new_flow_template')}
          </label>
          <div className="space-y-2">
            {(['empty', 'copy-default', 'minimal'] as const).map((opt) => (
              <label
                key={opt}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  template === opt
                    ? 'border-accent bg-accent/5'
                    : 'border-default hover:border-accent/50'
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  value={opt}
                  checked={template === opt}
                  onChange={() => setTemplate(opt)}
                  className="accent-accent"
                />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {t(`v2_new_flow_template_${opt.replace('-', '_')}`)}
                  </div>
                  <div className="text-xs text-foreground-muted">
                    {t(`v2_new_flow_template_${opt.replace('-', '_')}_desc`)}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            {t('v2_new_flow_cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleCreate} disabled={!name.trim()}>
            {t('v2_new_flow_create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
