/**
 * AttributeDetailPanel
 *
 * SlidePanel for viewing and editing a single attribute's properties.
 * Tier pills, displayName, product scope, data type, aliases, definition,
 * discovery stats, and interaction stats.
 */

'use client';

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAttributeDetail } from '../../../hooks/useAttributes';
import { updateAttribute } from '../../../api/search-ai';
import type { AttributeTier, AttributeRegistryItem } from '../../../api/search-ai';
import { SlidePanel } from '../../ui/SlidePanel';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { AttributeTierBadge } from './AttributeTierBadge';

interface AttributeDetailPanelProps {
  attributeId: string | null;
  indexId: string;
  onClose: () => void;
  onSave: () => void;
}

const TIERS: AttributeTier[] = ['permanent', 'approved', 'beta', 'novel', 'discarded'];

export function AttributeDetailPanel({
  attributeId,
  indexId,
  onClose,
  onSave,
}: AttributeDetailPanelProps) {
  const t = useTranslations('search_ai.kg');
  const { data: attribute, isLoading } = useAttributeDetail(indexId, attributeId);

  // Local edit state
  const [editTier, setEditTier] = useState<AttributeTier | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const [editDefinition, setEditDefinition] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync local state when attribute loads
  useEffect(() => {
    if (attribute) {
      setEditTier(attribute.tier);
      setEditDisplayName(attribute.displayName || '');
      setEditAliases((attribute.aliases ?? []).join(', '));
      setEditDefinition(attribute.definition || '');
    }
  }, [attribute]);

  const handleSave = async () => {
    if (!attributeId || !editTier) return;
    setSaving(true);
    try {
      const updates: Partial<{
        tier: AttributeTier;
        displayName: string;
        aliases: string[];
        definition: string;
      }> = {};

      if (editTier !== attribute?.tier) updates.tier = editTier;
      if (editDisplayName !== (attribute?.displayName || '')) updates.displayName = editDisplayName;
      const newAliases = editAliases
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (JSON.stringify(newAliases) !== JSON.stringify(attribute?.aliases ?? []))
        updates.aliases = newAliases;
      if (editDefinition !== (attribute?.definition || '')) updates.definition = editDefinition;

      if (Object.keys(updates).length > 0) {
        await updateAttribute(indexId, attributeId, updates);
        toast.success(t('attr_updated_success'));
        onSave();
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    if (!attributeId) return;
    setSaving(true);
    try {
      await updateAttribute(indexId, attributeId, { tier: 'discarded' });
      toast.success(t('attr_discarded_success'));
      onSave();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    if (!attributeId) return;
    setSaving(true);
    try {
      await updateAttribute(indexId, attributeId, { tier: 'approved' });
      toast.success(t('attr_approved_success'));
      onSave();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SlidePanel
      open={!!attributeId}
      onClose={onClose}
      title={attribute?.displayName || attribute?.attributeId || t('attr_detail_title')}
      width="md"
    >
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-10 w-full" />
          ))}
        </div>
      ) : attribute ? (
        <div className="space-y-6">
          {/* Tier Pills */}
          <div>
            <label className="text-xs font-medium text-muted mb-2 block">
              {t('attr_label_tier')}
            </label>
            <div className="flex flex-wrap gap-2">
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  onClick={() => setEditTier(tier)}
                  className={clsx(
                    'rounded-full transition-default',
                    editTier === tier
                      ? 'ring-2 ring-accent ring-offset-1'
                      : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <AttributeTierBadge tier={tier} />
                </button>
              ))}
            </div>
          </div>

          {/* Display Name */}
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t('attr_label_display_name')}
            </label>
            <input
              type="text"
              value={editDisplayName}
              onChange={(e) => setEditDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:outline-none focus:ring-1 focus:ring-border-focus"
              placeholder={attribute.attributeId}
            />
          </div>

          {/* Product Scope (read-only) */}
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t('attr_label_product_scope')}
            </label>
            <Badge variant="default">{attribute.productScope}</Badge>
          </div>

          {/* Data Type (read-only) */}
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t('attr_label_data_type')}
            </label>
            <span className="text-sm">{attribute.dataType}</span>
          </div>

          {/* Aliases */}
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t('attr_label_aliases')}
            </label>
            <input
              type="text"
              value={editAliases}
              onChange={(e) => setEditAliases(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:outline-none focus:ring-1 focus:ring-border-focus"
              placeholder={t('attr_aliases_placeholder')}
            />
          </div>

          {/* Definition */}
          <div>
            <label className="text-xs font-medium text-muted mb-1 block">
              {t('attr_label_definition')}
            </label>
            <textarea
              value={editDefinition}
              onChange={(e) => setEditDefinition(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:outline-none focus:ring-1 focus:ring-border-focus resize-none"
              placeholder={t('attr_definition_placeholder')}
            />
          </div>

          {/* Discovery Stats */}
          <div className="border-t border-default pt-4">
            <label className="text-xs font-medium text-muted mb-2 block">
              {t('attr_label_discovery')}
            </label>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted">{t('attr_label_source')}</span>
                <p className="font-medium">
                  {attribute.discoverySource ?? t('attr_discovery_auto')}
                </p>
              </div>
              <div>
                <span className="text-muted">{t('attr_label_documents')}</span>
                <p className="font-medium">{(attribute.documentCount ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <span className="text-muted">{t('attr_label_first_seen')}</span>
                <p className="font-medium">
                  {attribute.firstSeenAt
                    ? new Date(attribute.firstSeenAt).toLocaleDateString()
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted">{t('attr_label_last_seen')}</span>
                <p className="font-medium">
                  {attribute.lastSeenAt ? new Date(attribute.lastSeenAt).toLocaleDateString() : '—'}
                </p>
              </div>
            </div>
          </div>

          {/* Interaction Stats */}
          {(attribute.uniqueUsers || attribute.totalInteractions) && (
            <div className="border-t border-default pt-4">
              <label className="text-xs font-medium text-muted mb-2 block">
                {t('attr_label_interactions')}
              </label>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-muted">{t('attr_label_unique_users')}</span>
                  <p className="font-medium">{(attribute.uniqueUsers ?? 0).toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-muted">{t('attr_label_total_interactions')}</span>
                  <p className="font-medium">
                    {(attribute.totalInteractions ?? 0).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="border-t border-default pt-4 flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t('attr_cancel')}
            </Button>
            <Button variant="danger" size="sm" onClick={handleDiscard} loading={saving}>
              {t('attr_discard')}
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" size="sm" onClick={handleApprove} loading={saving}>
              {t('attr_approve')}
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              {t('attr_save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">{t('attr_not_found')}</p>
      )}
    </SlidePanel>
  );
}
