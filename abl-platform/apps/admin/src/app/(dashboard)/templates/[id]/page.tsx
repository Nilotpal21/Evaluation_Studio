'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Save, Loader2, RefreshCw } from 'lucide-react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { PageHeader, EmptyState, SkeletonTable } from '@agent-platform/admin-ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Template {
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: string[];
  complexity: string;
  type: string;
  status: string;
  installCount: number;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDetailResponse {
  success: boolean;
  data: {
    template: Template;
  };
}

interface TemplateFormData {
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: string;
  complexity: string;
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_OPTIONS = [
  'customer-service',
  'sales',
  'hr',
  'finance',
  'healthcare',
  'education',
  'general',
  'other',
];

const COMPLEXITY_OPTIONS = ['starter', 'standard', 'advanced'];

const STATUS_OPTIONS = ['draft', 'published', 'archived'];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EditTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const { data, loading, error, refetch } = useApi<TemplateDetailResponse>(`/api/templates/${id}`);

  const [formData, setFormData] = useState<TemplateFormData>({
    name: '',
    shortDescription: '',
    longDescription: '',
    category: '',
    tags: '',
    complexity: 'standard',
    status: 'draft',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [formInitialized, setFormInitialized] = useState(false);

  // Populate form when data loads
  useEffect(() => {
    if (data?.data?.template && !formInitialized) {
      const t = data.data.template;
      setFormData({
        name: t.name,
        shortDescription: t.shortDescription ?? '',
        longDescription: t.longDescription ?? '',
        category: t.category ?? '',
        tags: Array.isArray(t.tags) ? t.tags.join(', ') : '',
        complexity: t.complexity ?? 'standard',
        status: t.status ?? 'draft',
      });
      setFormInitialized(true);
    }
  }, [data, formInitialized]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const tags = formData.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await fetch(`/api/templates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          shortDescription: formData.shortDescription,
          longDescription: formData.longDescription,
          category: formData.category,
          tags,
          complexity: formData.complexity,
          status: formData.status,
        }),
      });

      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }

      const result = await res.json();

      if (!res.ok || !result.success) {
        const rawError = result.error;
        const errorMsg =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? String(rawError.message)
              : `Save failed with status ${res.status}`;
        setSaveError(errorMsg);
        return;
      }

      setSaveSuccess(true);
      refetch();

      // Clear success feedback after 3 seconds
      setTimeout(() => {
        setSaveSuccess(false);
      }, 3000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setSaving(false);
    }
  }, [id, formData, refetch]);

  const updateField = <K extends keyof TemplateFormData>(key: K, value: TemplateFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setSaveSuccess(false);
  };

  const inputClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed';
  const selectClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed';
  const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

  if (loading && !data) {
    return (
      <div>
        <PageHeader title="Edit Template" />
        <SkeletonTable rows={6} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Edit Template" />
        <EmptyState
          title="Failed to load template"
          description={error}
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          }
        />
      </div>
    );
  }

  const template = data?.data?.template;

  return (
    <div>
      <PageHeader
        title={template ? `Edit: ${template.name}` : 'Edit Template'}
        description={template ? `ID: ${template.id}` : undefined}
        actions={
          <button
            onClick={() => router.push('/templates')}
            className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
          >
            <ArrowLeft size={14} />
            Back to Templates
          </button>
        }
      />

      <div className="max-w-2xl space-y-6">
        {/* Read-only info */}
        {template && (
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div>
                <span className="text-foreground-muted">Type</span>
                <p className="text-foreground font-medium mt-0.5">
                  {template.type.charAt(0).toUpperCase() + template.type.slice(1)}
                </p>
              </div>
              <div>
                <span className="text-foreground-muted">Installs</span>
                <p className="text-foreground font-medium mt-0.5">
                  {template.installCount.toLocaleString()}
                </p>
              </div>
              <div>
                <span className="text-foreground-muted">Created</span>
                <p className="text-foreground font-medium mt-0.5">
                  {new Date(template.createdAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Edit Form */}
        <div className="rounded-lg border border-border bg-background-subtle p-4 space-y-4">
          <div>
            <label htmlFor="edit-name" className={labelClass}>
              Name
            </label>
            <input
              id="edit-name"
              type="text"
              value={formData.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Template name"
              className={inputClass}
              disabled={saving}
            />
          </div>

          <div>
            <label htmlFor="edit-short-desc" className={labelClass}>
              Short Description
            </label>
            <input
              id="edit-short-desc"
              type="text"
              value={formData.shortDescription}
              onChange={(e) => updateField('shortDescription', e.target.value)}
              placeholder="Brief description"
              className={inputClass}
              disabled={saving}
            />
          </div>

          <div>
            <label htmlFor="edit-long-desc" className={labelClass}>
              Long Description
            </label>
            <textarea
              id="edit-long-desc"
              value={formData.longDescription}
              onChange={(e) => updateField('longDescription', e.target.value)}
              placeholder="Detailed description"
              rows={4}
              className={`${inputClass} h-auto py-2`}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="edit-category" className={labelClass}>
                Category
              </label>
              <select
                id="edit-category"
                value={formData.category}
                onChange={(e) => updateField('category', e.target.value)}
                className={selectClass}
                disabled={saving}
              >
                <option value="">Select category</option>
                {CATEGORY_OPTIONS.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat
                      .split('-')
                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ')}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="edit-complexity" className={labelClass}>
                Complexity
              </label>
              <select
                id="edit-complexity"
                value={formData.complexity}
                onChange={(e) => updateField('complexity', e.target.value)}
                className={selectClass}
                disabled={saving}
              >
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="edit-tags" className={labelClass}>
              Tags (comma-separated)
            </label>
            <input
              id="edit-tags"
              type="text"
              value={formData.tags}
              onChange={(e) => updateField('tags', e.target.value)}
              placeholder="customer-service, chatbot, onboarding"
              className={inputClass}
              disabled={saving}
            />
          </div>

          <div>
            <label htmlFor="edit-status" className={labelClass}>
              Status
            </label>
            <select
              id="edit-status"
              value={formData.status}
              onChange={(e) => updateField('status', e.target.value)}
              className={selectClass}
              disabled={saving}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {saveError && (
          <div className="flex items-start gap-2 rounded-lg border border-error/25 bg-error/10 px-4 py-3">
            <p className="text-sm text-error">{saveError}</p>
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-4 py-3">
            <p className="text-sm text-success">Template saved successfully.</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => router.push('/templates')}
            disabled={saving}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !formData.name.trim()}
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save size={14} />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
