'use client';

/**
 * AttachmentConfigTab — Tenant attachment configuration management.
 *
 * Displays and allows editing of per-tenant attachment settings:
 * - File size limits, MIME type allow/block lists
 * - Feature toggles (scan, processing, embedding)
 * - PII policy, session limits, storage limits, retention
 *
 * Follows the existing OverviewTab pattern: useApi for loading,
 * raw fetch() for mutations, inline error/success banners.
 */

import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { SkeletonTable, EmptyState } from '@agent-platform/admin-ui';

// =============================================================================
// TYPES
// =============================================================================

interface AttachmentConfig {
  tenantId: string;
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  blockedMimeTypes: string[];
  scanEnabled: boolean;
  processingEnabled: boolean;
  embeddingEnabled: boolean;
  maxAttachmentsPerSession: number;
  maxTotalStorageBytes: number;
  retentionDays: Record<string, number>;
}

interface AttachmentConfigResponse {
  success: boolean;
  data: {
    config: AttachmentConfig;
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function parseBytesInput(value: string): number | null {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 0) return null;
  return num;
}

const RETENTION_CATEGORIES = ['image', 'document', 'audio', 'video'] as const;

// =============================================================================
// COMPONENT
// =============================================================================

export function AttachmentConfigTab({ tenantId }: { tenantId: string }) {
  const { data, loading, error, refetch } = useApi<AttachmentConfigResponse>(
    `/api/admin/tenant-attachment-config?tenantId=${encodeURIComponent(tenantId)}`,
  );

  // Form state
  const [formState, setFormState] = useState<AttachmentConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Sync form state when data loads
  useEffect(() => {
    if (data?.data?.config && !dirty) {
      setFormState(data.data.config);
    }
  }, [data, dirty]);

  const resetForm = useCallback(() => {
    if (data?.data?.config) {
      setFormState(data.data.config);
      setDirty(false);
      setSaveError(null);
      setSaveSuccess(null);
    }
  }, [data]);

  const updateField = useCallback(
    <K extends keyof AttachmentConfig>(key: K, value: AttachmentConfig[K]) => {
      setFormState((prev) => {
        if (!prev) return prev;
        return { ...prev, [key]: value };
      });
      setDirty(true);
      setSaveSuccess(null);
    },
    [],
  );

  const handleSave = async () => {
    if (!formState || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const body: Record<string, unknown> = {};
      const original = data?.data?.config;
      if (!original) return;

      // Only send changed fields
      if (formState.maxFileSizeBytes !== original.maxFileSizeBytes) {
        body.maxFileSizeBytes = formState.maxFileSizeBytes;
      }
      if (
        JSON.stringify(formState.allowedMimeTypes) !== JSON.stringify(original.allowedMimeTypes)
      ) {
        body.allowedMimeTypes = formState.allowedMimeTypes;
      }
      if (
        JSON.stringify(formState.blockedMimeTypes) !== JSON.stringify(original.blockedMimeTypes)
      ) {
        body.blockedMimeTypes = formState.blockedMimeTypes;
      }
      if (formState.scanEnabled !== original.scanEnabled) {
        body.scanEnabled = formState.scanEnabled;
      }
      if (formState.processingEnabled !== original.processingEnabled) {
        body.processingEnabled = formState.processingEnabled;
      }
      if (formState.embeddingEnabled !== original.embeddingEnabled) {
        body.embeddingEnabled = formState.embeddingEnabled;
      }
      if (formState.maxAttachmentsPerSession !== original.maxAttachmentsPerSession) {
        body.maxAttachmentsPerSession = formState.maxAttachmentsPerSession;
      }
      if (formState.maxTotalStorageBytes !== original.maxTotalStorageBytes) {
        body.maxTotalStorageBytes = formState.maxTotalStorageBytes;
      }
      if (JSON.stringify(formState.retentionDays) !== JSON.stringify(original.retentionDays)) {
        body.retentionDays = formState.retentionDays;
      }

      if (Object.keys(body).length === 0) {
        setDirty(false);
        return;
      }

      const res = await fetch(
        `/api/admin/tenant-attachment-config?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (res.ok) {
        setSaveSuccess('Attachment configuration updated successfully');
        setDirty(false);
        refetch();
      } else {
        const responseBody = await res.json().catch(() => null);
        const message =
          responseBody?.error?.message ||
          responseBody?.error ||
          `Failed to save configuration (HTTP ${res.status})`;
        setSaveError(typeof message === 'string' ? message : 'Failed to save configuration');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // Loading state
  if (loading && !data) {
    return <SkeletonTable rows={6} />;
  }

  // Error state
  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load attachment config"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-white rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!formState) return null;

  return (
    <div className="space-y-6">
      {/* Success Banner */}
      {saveSuccess && (
        <div className="rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-success flex items-center justify-between">
          <span>{saveSuccess}</span>
          <button
            onClick={() => setSaveSuccess(null)}
            className="ml-4 text-success hover:text-success-muted transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Error Banner */}
      {saveError && (
        <div className="rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error flex items-center justify-between">
          <span>{saveError}</span>
          <button
            onClick={() => setSaveError(null)}
            className="ml-4 text-error hover:text-error-muted transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* File Size & Storage Limits */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">File Size Limits</h3>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-foreground-muted mb-1">
                Max File Size ({formatBytes(formState.maxFileSizeBytes)})
              </dt>
              <dd>
                <input
                  type="number"
                  value={formState.maxFileSizeBytes}
                  onChange={(e) => {
                    const val = parseBytesInput(e.target.value);
                    if (val !== null) updateField('maxFileSizeBytes', val);
                  }}
                  min={1024}
                  max={500 * 1024 * 1024}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <span className="text-xs text-foreground-muted mt-1 block">
                  Min: 1 KB, Max: 500 MB (in bytes)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-foreground-muted mb-1">Max Attachments Per Session</dt>
              <dd>
                <input
                  type="number"
                  value={formState.maxAttachmentsPerSession}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 1) updateField('maxAttachmentsPerSession', val);
                  }}
                  min={1}
                  max={10000}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </dd>
            </div>
            <div>
              <dt className="text-sm text-foreground-muted mb-1">
                Max Total Storage ({formatBytes(formState.maxTotalStorageBytes)})
              </dt>
              <dd>
                <input
                  type="number"
                  value={formState.maxTotalStorageBytes}
                  onChange={(e) => {
                    const val = parseBytesInput(e.target.value);
                    if (val !== null && val >= 1) updateField('maxTotalStorageBytes', val);
                  }}
                  min={1}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <span className="text-xs text-foreground-muted mt-1 block">
                  Total storage limit per tenant (in bytes)
                </span>
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Feature Toggles</h3>
          <dl className="space-y-3">
            {(['scanEnabled', 'processingEnabled', 'embeddingEnabled'] as const).map((field) => (
              <div key={field} className="flex items-center justify-between">
                <dt className="text-sm text-foreground">
                  {field === 'scanEnabled'
                    ? 'Virus Scanning'
                    : field === 'processingEnabled'
                      ? 'Content Processing'
                      : 'Embedding Generation'}
                </dt>
                <dd>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={formState[field]}
                    onClick={() => updateField(field, !formState[field])}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      formState[field] ? 'bg-accent' : 'bg-foreground/20'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formState[field] ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/* MIME Types */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Allowed MIME Types</h3>
          <p className="text-xs text-foreground-muted mb-2">
            Empty list allows all types. One entry per line.
          </p>
          <textarea
            value={formState.allowedMimeTypes.join('\n')}
            onChange={(e) => {
              const types = e.target.value
                .split('\n')
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
              updateField('allowedMimeTypes', types);
            }}
            rows={4}
            placeholder="image/png&#10;image/jpeg&#10;application/pdf"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Blocked MIME Types</h3>
          <p className="text-xs text-foreground-muted mb-2">
            Blocked types take precedence over allowed types.
          </p>
          <textarea
            value={formState.blockedMimeTypes.join('\n')}
            onChange={(e) => {
              const types = e.target.value
                .split('\n')
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
              updateField('blockedMimeTypes', types);
            }}
            rows={4}
            placeholder="application/x-executable&#10;application/x-msdownload"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>
      </div>

      {/* Retention Days */}
      <div className="rounded-lg border border-border bg-background-subtle p-5">
        <h3 className="text-sm font-medium text-foreground-muted mb-3">
          Retention Days by Category
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {RETENTION_CATEGORIES.map((category) => (
            <div key={category}>
              <label className="text-sm text-foreground-muted capitalize block mb-1">
                {category}
              </label>
              <input
                type="number"
                value={formState.retentionDays[category] ?? 90}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val) && val >= 1 && val <= 365) {
                    updateField('retentionDays', {
                      ...formState.retentionDays,
                      [category]: val,
                    });
                  }
                }}
                min={1}
                max={365}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          ))}
        </div>
        <span className="text-xs text-foreground-muted mt-2 block">1-365 days per category</span>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={`rounded-md px-4 py-2 text-sm font-medium text-white transition-colors ${
            saving || !dirty ? 'bg-accent/50 cursor-not-allowed' : 'bg-accent hover:bg-accent/90'
          }`}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          onClick={resetForm}
          disabled={saving || !dirty}
          className={`rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors ${
            saving || !dirty ? 'opacity-50 cursor-not-allowed' : 'hover:bg-background-muted'
          }`}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
