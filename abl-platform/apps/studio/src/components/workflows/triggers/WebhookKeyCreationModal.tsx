'use client';

/**
 * WebhookKeyCreationModal
 *
 * Modal dialog for creating or selecting a platform key with workflows.execute
 * permission. Shows existing matching keys in a dropdown and allows
 * creating a new one. Displays the raw key once with a copy-to-clipboard
 * button and a warning that it cannot be retrieved later.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, AlertTriangle, Key, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch, handleResponse } from '../../../lib/api-client';
import { sanitizeError } from '../../../lib/sanitize-error';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revokedAt?: string | null;
  expiresAt?: string | null;
}

interface PlatformKeyListResponse {
  keys: PlatformKey[];
}

interface PlatformKeyCreateResponse {
  id: string;
  key: string;
  prefix: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WebhookKeyCreationModalProps {
  workflowId: string;
  projectId: string;
  workflowName: string;
  onKeyCreated: (key: { id: string; rawKey: string; name: string }) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WebhookKeyCreationModal({
  workflowId: _workflowId,
  projectId,
  workflowName,
  onKeyCreated,
  onClose,
}: WebhookKeyCreationModalProps) {
  const t = useTranslations('workflows.triggers');

  const [existingKeys, setExistingKeys] = useState<PlatformKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{
    id: string;
    rawKey: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Suppress unused-variable lint for workflowId (used in key name context)
  void _workflowId;

  // Fetch existing platform keys for this project.
  useEffect(() => {
    let cancelled = false;

    async function fetchKeys() {
      try {
        const url = `/api/keys?projectId=${encodeURIComponent(projectId)}`;
        const response = await apiFetch(url);
        const result = await handleResponse<PlatformKeyListResponse>(response);
        if (cancelled) return;

        // /api/keys GET already excludes revoked and expired keys server-side
        setExistingKeys(result.keys ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(sanitizeError(err, 'Failed to load existing keys'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchKeys();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);

    try {
      const name = t('key_created_name', { name: workflowName });
      const response = await apiFetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          scopes: ['workflows.execute'],
          projectIds: [projectId],
        }),
      });
      const result = await handleResponse<PlatformKeyCreateResponse>(response);
      const keyData = { id: result.id, rawKey: result.key, name: result.name };
      setCreatedKey(keyData);
      onKeyCreated(keyData);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to create API key'));
    } finally {
      setCreating(false);
    }
  }, [projectId, workflowName, onKeyCreated, t]);

  const handleCopy = useCallback(async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in some contexts
    }
  }, [createdKey]);

  return (
    <Dialog open onClose={onClose} title={t('create_key')} maxWidth="md">
      <div className="space-y-4">
        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {/* Created key display */}
        {createdKey && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle p-3">
              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-warning">{t('key_warning')}</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">{t('api_key_status')}</label>
              <div className="flex items-center gap-2">
                <code
                  className={clsx(
                    'flex-1 text-xs font-mono px-3 py-2 rounded-lg truncate',
                    'bg-background-muted text-foreground border border-default',
                  )}
                >
                  {createdKey.rawKey}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={
                    copied ? (
                      <Check className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )
                  }
                  onClick={handleCopy}
                  aria-label={t('copy_curl')}
                >
                  {t('copy_curl')}
                </Button>
              </div>
            </div>

            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={onClose}>
                {t('title')}
              </Button>
            </div>
          </div>
        )}

        {/* Key selection / creation form */}
        {!loading && !createdKey && (
          <div className="space-y-4">
            {/* Existing keys dropdown */}
            {existingKeys.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted">{t('or_select_existing')}</label>
                <select
                  value={selectedKeyId}
                  onChange={(e) => setSelectedKeyId(e.target.value)}
                  aria-label={t('or_select_existing')}
                  className={clsx(
                    'w-full px-3 py-2 text-sm rounded-lg border border-default',
                    'bg-background-muted text-foreground',
                    'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
                  )}
                >
                  <option value="">--</option>
                  {existingKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.prefix}...)
                    </option>
                  ))}
                </select>
                {selectedKeyId && (
                  <div className="flex items-center gap-2 mt-2">
                    <Key className="w-3.5 h-3.5 text-muted" />
                    <span className="text-xs text-muted">
                      {existingKeys.find((k) => k.id === selectedKeyId)?.prefix ?? ''}
                      ...
                    </span>
                    <Badge variant="success">{t('key_active')}</Badge>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {error && <p className="text-xs text-error">{error}</p>}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={onClose} disabled={creating}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreate}
                loading={creating}
                icon={<Key className="w-3.5 h-3.5" />}
              >
                {t('create_key')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
