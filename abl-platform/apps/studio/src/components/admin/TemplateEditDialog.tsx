/**
 * TemplateEditDialog Component
 *
 * Modal dialog for editing template metadata (name, description, category,
 * tags, complexity, status). Follows the same Dialog + form pattern as
 * TemplateUploadDialog's metadata step.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// CONSTANTS
// =============================================================================

const COMPLEXITY_OPTIONS = [
  { value: 'starter', label: 'Starter' },
  { value: 'standard', label: 'Standard' },
  { value: 'advanced', label: 'Advanced' },
];

const CATEGORY_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'customer-service', label: 'Customer Service' },
  { value: 'sales', label: 'Sales' },
  { value: 'operations', label: 'Operations' },
  { value: 'hr', label: 'Human Resources' },
  { value: 'finance', label: 'Finance' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'education', label: 'Education' },
  { value: 'other', label: 'Other' },
];

const STATUS_OPTIONS = [
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

// =============================================================================
// TYPES
// =============================================================================

interface Template {
  id: string;
  name: string;
  type: string;
  category: string;
  status: string;
  downloads: number;
  createdAt: string;
  shortDescription?: string;
  longDescription?: string;
  tags?: string[];
  complexity?: string;
}

interface TemplateEditDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  template: Template;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TemplateEditDialog({
  open,
  onClose,
  onSuccess,
  template,
}: TemplateEditDialogProps) {
  const t = useTranslations('admin');

  const [name, setName] = useState(template.name);
  const [shortDescription, setShortDescription] = useState(template.shortDescription ?? '');
  const [longDescription, setLongDescription] = useState(template.longDescription ?? '');
  const [category, setCategory] = useState(template.category ?? 'general');
  const [tags, setTags] = useState(Array.isArray(template.tags) ? template.tags.join(', ') : '');
  const [complexity, setComplexity] = useState(template.complexity ?? 'standard');
  const [status, setStatus] = useState(template.status ?? 'draft');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // SUBMIT
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    if (!name.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/template-store/admin/templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          shortDescription: shortDescription.trim(),
          longDescription: longDescription.trim(),
          category,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          complexity,
          status,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Failed to update template');
      }

      onSuccess();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to update template'));
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <Dialog open={open} onClose={onClose} title={t('template_manager.editTitle')} maxWidth="lg">
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('template_manager.editDescription')}</p>

        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-error shrink-0" />
              <span className="text-sm text-error">{error}</span>
            </div>
          </div>
        )}

        <Input
          label={t('template_manager.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <Input
          label={t('template_manager.shortDescription')}
          value={shortDescription}
          onChange={(e) => setShortDescription(e.target.value)}
        />

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('template_manager.longDescription')}
          </label>
          <textarea
            value={longDescription}
            onChange={(e) => setLongDescription(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-default resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t('template_manager.category')}
            options={CATEGORY_OPTIONS}
            value={category}
            onChange={setCategory}
          />
          <Select
            label={t('template_manager.complexity')}
            options={COMPLEXITY_OPTIONS}
            value={complexity}
            onChange={setComplexity}
          />
        </div>

        <Input
          label={t('template_manager.tags')}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t('template_manager.tagsPlaceholder')}
        />

        <Select
          label={t('template_manager.status')}
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
        />

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('template_manager.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={!name.trim()}
            onClick={handleSubmit}
            icon={loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
          >
            {t('template_manager.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
