/**
 * GeneralSection Component
 *
 * Editable name/description fields plus read-only metadata.
 * PATCHes to /api/search-ai/knowledge-bases/:id on save.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Textarea';
import { apiFetch } from '../../../lib/api-client';
import { sanitizeError } from '@/lib/sanitize-error';
import type { KnowledgeBaseDetail } from '../../../api/search-ai';

interface GeneralSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onUpdate: () => void;
}

export function GeneralSection({ knowledgeBase, onUpdate }: GeneralSectionProps) {
  const t = useTranslations('search_ai.settings_general');
  const [name, setName] = useState(knowledgeBase.name);
  const [description, setDescription] = useState(knowledgeBase.description ?? '');
  const [saving, setSaving] = useState(false);

  const hasChanges =
    name !== knowledgeBase.name || description !== (knowledgeBase.description ?? '');

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t('error_name_required'));
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch(`/api/search-ai/knowledge-bases/${knowledgeBase._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.error === 'string' ? body.error : (body.error?.message ?? 'Update failed'),
        );
      }
      toast.success(t('toast_updated'));
      onUpdate();
    } catch (err) {
      toast.error(sanitizeError(err, t('error_update_failed')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>

      <Input label={t('label_name')} value={name} onChange={(e) => setName(e.target.value)} />

      <Textarea
        label={t('label_description')}
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('placeholder_description')}
      />

      {hasChanges && (
        <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
          {t('save_changes')}
        </Button>
      )}

      {/* Read-only fields */}
      <div className="pt-4 border-t border-default space-y-3">
        <ReadOnlyField label={t('label_status')} value={knowledgeBase.status} />
        <ReadOnlyField
          label={t('label_search_index_id')}
          value={knowledgeBase.searchIndexId ?? '\u2014'}
        />
        <ReadOnlyField label={t('label_created')} value={formatDate(knowledgeBase.createdAt)} />
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}
