/**
 * AttributeMergeDialog
 *
 * Side-by-side comparison dialog for merging two attributes.
 * Shows source and target attributes, allows selecting the primary
 * (attribute to keep), previews the merged result, and calls the
 * merge API on confirmation.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { Loader2, ArrowRight, Merge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Dialog } from '../../ui/Dialog';
import { AttributeTierBadge } from './AttributeTierBadge';
import { mergeAttributes } from '../../../api/search-ai';
import type { AttributeRegistryItem } from '../../../api/search-ai';

export interface AttributeMergeDialogProps {
  source: AttributeRegistryItem;
  target: AttributeRegistryItem;
  indexId: string;
  open: boolean;
  onClose: () => void;
  onMergeComplete: () => void;
}

function AttributeColumn({
  attr,
  isPrimary,
  onSelect,
  label,
}: {
  attr: AttributeRegistryItem;
  isPrimary: boolean;
  onSelect: () => void;
  label: string;
}) {
  const t = useTranslations('search_ai.kg');
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex-1 p-4 rounded-lg border-2 text-left transition-default ${
        isPrimary ? 'border-accent bg-accent/5' : 'border-default hover:border-muted'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-muted uppercase tracking-wider">{label}</span>
        <div className="flex items-center gap-2">
          {isPrimary && (
            <span className="text-xs font-medium text-accent">{t('attr_merge_primary')}</span>
          )}
          <input
            type="radio"
            checked={isPrimary}
            onChange={onSelect}
            className="accent-accent"
            aria-label={t('attr_merge_select_primary', { label })}
          />
        </div>
      </div>

      <p className="text-sm font-semibold mb-1 truncate">{attr.displayName || attr.attributeId}</p>
      <p className="text-xs text-muted mb-3 truncate">{attr.attributeId}</p>

      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted">{t('attr_label_product_scope')}</span>
          <span>{attr.productScope}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted">{t('attr_label_data_type')}</span>
          <span>{attr.dataType}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted">{t('attr_label_documents')}</span>
          <span>{(attr.documentCount ?? 0).toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted">{t('attr_label_confidence')}</span>
          <span>
            {attr.confidence != null ? `${(attr.confidence * 100).toFixed(0)}%` : t('attr_na')}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted">{t('attr_label_tier')}</span>
          <AttributeTierBadge tier={attr.tier} />
        </div>
        {attr.aliases.length > 0 && (
          <div>
            <span className="text-muted block mb-1">{t('attr_label_aliases_short')}</span>
            <div className="flex flex-wrap gap-1">
              {attr.aliases.map((alias) => (
                <span key={alias} className="px-1.5 py-0.5 bg-background-muted rounded text-xs">
                  {alias}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </button>
  );
}

export function AttributeMergeDialog({
  source,
  target,
  indexId,
  open,
  onClose,
  onMergeComplete,
}: AttributeMergeDialogProps) {
  const t = useTranslations('search_ai.kg');
  const [primaryId, setPrimaryId] = useState<string>(source._id);
  const [isMerging, setIsMerging] = useState(false);

  // Compute merged preview
  const preview = useMemo(() => {
    const primary = primaryId === source._id ? source : target;
    const secondary = primaryId === source._id ? target : source;

    // Deduplicate aliases
    const allAliases = new Set([
      ...primary.aliases,
      ...secondary.aliases,
      // Add the secondary's display name as an alias if different
      ...(secondary.displayName && secondary.displayName !== primary.displayName
        ? [secondary.displayName]
        : []),
    ]);

    return {
      displayName: primary.displayName || primary.attributeId,
      attributeId: primary.attributeId,
      productScope: primary.productScope,
      dataType: primary.dataType,
      tier: primary.tier,
      documentCount: (primary.documentCount ?? 0) + (secondary.documentCount ?? 0),
      aliases: Array.from(allAliases),
    };
  }, [primaryId, source, target]);

  const handleMerge = useCallback(async () => {
    setIsMerging(true);
    try {
      await mergeAttributes(indexId, source._id, target._id, primaryId);
      toast.success(t('attr_merge_success'));
      onMergeComplete();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMerging(false);
    }
  }, [indexId, source._id, target._id, primaryId, onMergeComplete, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('attr_merge_dialog_title')}
      description={t('attr_merge_dialog_description')}
      maxWidth="2xl"
    >
      <div className="space-y-6">
        {/* Side-by-side comparison */}
        <div className="flex gap-4">
          <AttributeColumn
            attr={source}
            isPrimary={primaryId === source._id}
            onSelect={() => setPrimaryId(source._id)}
            label={t('attr_merge_source')}
          />

          <div className="flex items-center">
            <ArrowRight className="w-5 h-5 text-muted" />
          </div>

          <AttributeColumn
            attr={target}
            isPrimary={primaryId === target._id}
            onSelect={() => setPrimaryId(target._id)}
            label={t('attr_merge_target')}
          />
        </div>

        {/* Merge preview */}
        <div className="rounded-lg border border-default bg-background-muted/50 p-4">
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Merge className="w-4 h-4 text-accent" />
            {t('attr_merge_preview_title')}
          </h4>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('attr_label_display_name')}</span>
              <span className="font-medium">{preview.displayName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('attr_label_tier')}</span>
              <AttributeTierBadge tier={preview.tier} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('attr_merge_combined_docs')}</span>
              <span className="font-medium">{preview.documentCount.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('attr_label_data_type')}</span>
              <span>{preview.dataType}</span>
            </div>
            {preview.aliases.length > 0 && (
              <div className="col-span-2">
                <span className="text-muted block mb-1">
                  {t('attr_merge_aliases', { count: preview.aliases.length })}
                </span>
                <div className="flex flex-wrap gap-1">
                  {preview.aliases.map((alias) => (
                    <span
                      key={alias}
                      className="px-1.5 py-0.5 bg-background rounded border border-default text-xs"
                    >
                      {alias}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-default">
          <button
            type="button"
            onClick={onClose}
            disabled={isMerging}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-default hover:bg-background-muted transition-default disabled:opacity-50"
          >
            {t('attr_cancel')}
          </button>
          <button
            type="button"
            onClick={handleMerge}
            disabled={isMerging}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-default disabled:opacity-50 flex items-center gap-2"
          >
            {isMerging ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('attr_merging')}
              </>
            ) : (
              <>
                <Merge className="w-4 h-4" />
                {t('attr_merge_button')}
              </>
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
