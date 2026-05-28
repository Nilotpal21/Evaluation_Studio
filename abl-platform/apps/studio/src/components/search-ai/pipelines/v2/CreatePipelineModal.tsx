/**
 * CreatePipelineModal — modal for creating a new custom pipeline.
 *
 * Provides name, description, template choice (copy default or empty),
 * and a fallthrough explanation.
 */

'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';

export type PipelineTemplate = 'copy-default' | 'empty';

export interface CreatePipelineModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (name: string, description: string, template: PipelineTemplate) => void;
}

export function CreatePipelineModal({ open, onClose, onConfirm }: CreatePipelineModalProps) {
  const t = useTranslations('search_ai.pipeline');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<PipelineTemplate>('copy-default');

  const handleConfirm = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onConfirm(trimmedName, description.trim(), template);
    // Reset form state
    setName('');
    setDescription('');
    setTemplate('copy-default');
  }, [name, description, template, onConfirm]);

  const handleClose = useCallback(() => {
    setName('');
    setDescription('');
    setTemplate('copy-default');
    onClose();
  }, [onClose]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('v2_create_modal_title')}
      description={t('v2_create_modal_description')}
    >
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label htmlFor="pipeline-name" className="mb-1 block text-sm font-medium text-foreground">
            {t('v2_create_modal_name_label')}
          </label>
          <input
            id="pipeline-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('v2_create_modal_name_placeholder')}
            className="w-full rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Description */}
        <div>
          <label
            htmlFor="pipeline-description"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            {t('v2_create_modal_description_label')}
          </label>
          <textarea
            id="pipeline-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('v2_create_modal_description_placeholder')}
            rows={3}
            className="w-full resize-none rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Template choice */}
        <div>
          <span className="mb-2 block text-sm font-medium text-foreground">
            {t('v2_create_modal_template_label')}
          </span>
          <div className="space-y-2">
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                template === 'copy-default'
                  ? 'border-accent bg-accent/5'
                  : 'border-default bg-background hover:border-accent/50'
              }`}
            >
              <input
                type="radio"
                name="pipeline-template"
                value="copy-default"
                checked={template === 'copy-default'}
                onChange={() => setTemplate('copy-default')}
                className="mt-0.5 accent-accent"
              />
              <div>
                <span className="text-sm font-medium text-foreground">
                  {t('v2_create_modal_template_copy')}
                </span>
                <p className="mt-0.5 text-xs text-foreground-muted">
                  {t('v2_create_modal_template_copy_desc')}
                </p>
              </div>
            </label>
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                template === 'empty'
                  ? 'border-accent bg-accent/5'
                  : 'border-default bg-background hover:border-accent/50'
              }`}
            >
              <input
                type="radio"
                name="pipeline-template"
                value="empty"
                checked={template === 'empty'}
                onChange={() => setTemplate('empty')}
                className="mt-0.5 accent-accent"
              />
              <div>
                <span className="text-sm font-medium text-foreground">
                  {t('v2_create_modal_template_empty')}
                </span>
                <p className="mt-0.5 text-xs text-foreground-muted">
                  {t('v2_create_modal_template_empty_desc')}
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Fallthrough explanation */}
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs text-foreground-muted">{t('v2_create_modal_fallthrough_note')}</p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t('v2_create_modal_cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={!name.trim()}>
            {t('v2_create_modal_confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
