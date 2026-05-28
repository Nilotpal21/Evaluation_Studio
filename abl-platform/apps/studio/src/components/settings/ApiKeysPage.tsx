'use client';

/**
 * API Keys Page
 *
 * Personal credentials management for playground and testing.
 * Allows users to add, view, and delete their own API keys.
 */

import { useState, useEffect, useCallback } from 'react';
import clsx from 'clsx';
import { Key, Plus, Trash2, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiFetch } from '@/lib/api-client';
import { sanitizeError } from '@/lib/sanitize-error';
import { Select } from '../ui/Select';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Credential {
  id: string;
  name: string;
  provider: string;
  authType: string;
  isActive: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

type Provider =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'microsoft_foundry_anthropic'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'custom';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure' },
  { value: 'microsoft_foundry_anthropic', label: 'Microsoft Foundry Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'custom', label: 'Custom' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(date: string | null, neverUsed: string): string {
  if (!date) return neverUsed;
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function groupByProvider(credentials: Credential[]): Record<string, Credential[]> {
  const groups: Record<string, Credential[]> = {};
  for (const cred of credentials) {
    const key = cred.provider;
    if (!groups[key]) groups[key] = [];
    groups[key].push(cred);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className="bg-accent-subtle text-accent text-xs px-2 py-0.5 rounded-full">
      {provider}
    </span>
  );
}

function StatusDot({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={clsx(
        'inline-block w-2 h-2 rounded-full',
        isActive ? 'bg-success' : 'bg-foreground-subtle',
      )}
    />
  );
}

function CredentialCard({
  credential,
  onDelete,
  neverUsed,
  deleteAria,
}: {
  credential: Credential;
  onDelete: (id: string) => void;
  neverUsed: string;
  deleteAria: (name: string) => string;
}) {
  return (
    <div className="border border-default rounded-lg p-4 bg-background-muted flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Key className="w-4 h-4 text-muted shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{credential.name}</span>
            <ProviderBadge provider={credential.provider} />
            <StatusDot isActive={credential.isActive} />
          </div>
          <p className="text-xs text-muted mt-0.5">
            {relativeTime(credential.lastUsedAt, neverUsed)}
          </p>
        </div>
      </div>
      <button
        onClick={() => onDelete(credential.id)}
        className="text-muted hover:text-error transition-default p-1 rounded-md hover:bg-error-subtle shrink-0"
        aria-label={deleteAria(credential.name)}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

function EmptyState({ onAdd, t }: { onAdd: () => void; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-background-muted flex items-center justify-center mb-4">
        <Key className="w-6 h-6 text-muted" />
      </div>
      <h3 className="text-sm font-medium text-foreground mb-1">{t('empty_title')}</h3>
      <p className="text-xs text-muted mb-4 max-w-xs">{t('empty_description')}</p>
      <Button onClick={onAdd} size="sm" icon={<Plus className="w-4 h-4" />}>
        {t('add_key')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Key Modal
// ---------------------------------------------------------------------------

function AddKeyModal({
  isOpen,
  onClose,
  onSubmit,
  t,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    provider: Provider;
    apiKey: string;
    endpoint?: string;
    authConfig?: Record<string, unknown>;
  }) => Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [foundryAnthropicVersion, setFoundryAnthropicVersion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showEndpoint =
    provider === 'azure' || provider === 'microsoft_foundry_anthropic' || provider === 'custom';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !apiKey.trim()) return;
    if (provider === 'microsoft_foundry_anthropic' && !endpoint.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        provider,
        apiKey: apiKey.trim(),
        endpoint: showEndpoint && endpoint.trim() ? endpoint.trim() : undefined,
        authConfig:
          provider === 'microsoft_foundry_anthropic'
            ? {
                apiFormat: 'anthropic_messages',
                ...(foundryAnthropicVersion.trim()
                  ? { anthropicVersion: foundryAnthropicVersion.trim() }
                  : {}),
              }
            : undefined,
      });
      setName('');
      setProvider('openai');
      setApiKey('');
      setEndpoint('');
      setFoundryAnthropicVersion('');
      onClose();
    } catch (err) {
      setError(sanitizeError(err, t('failed_to_add')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title={t('add_api_key')} maxWidth="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label={t('label_name')}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('placeholder_name')}
          required
        />

        <div>
          <Select
            label={t('label_provider')}
            options={PROVIDERS}
            value={provider}
            onChange={(v) => setProvider(v as Provider)}
          />
        </div>

        <Input
          label={t('label_api_key')}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('placeholder_api_key')}
          required
        />

        {showEndpoint && (
          <Input
            label={
              provider === 'microsoft_foundry_anthropic'
                ? t('label_endpoint_url')
                : `${t('label_endpoint_url')} ${t('label_optional')}`
            }
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={
              provider === 'microsoft_foundry_anthropic'
                ? 'https://<resource>.services.ai.azure.com/anthropic'
                : t('placeholder_endpoint')
            }
            required={provider === 'microsoft_foundry_anthropic'}
          />
        )}

        {provider === 'microsoft_foundry_anthropic' && (
          <Input
            label={`${t('label_anthropic_version')} ${t('label_optional')}`}
            type="text"
            value={foundryAnthropicVersion}
            onChange={(e) => setFoundryAnthropicVersion(e.target.value)}
            placeholder={t('placeholder_anthropic_version')}
          />
        )}

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={submitting}
            disabled={
              submitting ||
              !name.trim() ||
              !apiKey.trim() ||
              (provider === 'microsoft_foundry_anthropic' && !endpoint.trim())
            }
          >
            {t('add_key')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function ApiKeysPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const t = useTranslations('settings.personal_api_keys');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await apiFetch('/api/credentials');
      if (!res.ok) throw new Error(t('failed_to_fetch'));
      const data = await res.json();
      setCredentials(data.credentials ?? []);
      setError(null);
    } catch (err) {
      setError(sanitizeError(err, t('failed_to_load')));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const handleAdd = async (data: {
    name: string;
    provider: Provider;
    apiKey: string;
    endpoint?: string;
    authConfig?: Record<string, unknown>;
  }) => {
    const res = await apiFetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch((parseErr) => {
        console.warn(
          'Failed to parse credential error response',
          parseErr instanceof Error ? parseErr.message : String(parseErr),
        );
        return null;
      });
      throw new Error(body?.error?.message ?? t('failed_to_create'));
    }
    await fetchCredentials();
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/credentials/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('failed_to_delete'));
      setCredentials((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(sanitizeError(err, t('failed_to_delete')));
    }
  };

  const grouped = groupByProvider(credentials);
  const providerKeys = Object.keys(grouped).sort();

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      {/* Header */}
      {!hideHeader && (
        <PageHeader
          title={t('title')}
          description={t('description_full')}
          className="mb-8"
          actions={
            credentials.length > 0 ? (
              <Button
                onClick={() => setShowModal(true)}
                size="sm"
                icon={<Plus className="w-4 h-4" />}
                className="shrink-0"
              >
                {t('add_key')}
              </Button>
            ) : null
          }
        />
      )}
      {hideHeader && credentials.length > 0 && (
        <div className="flex justify-end mb-4">
          <Button
            onClick={() => setShowModal(true)}
            size="sm"
            icon={<Plus className="w-4 h-4" />}
            className="shrink-0"
          >
            {t('add_key')}
          </Button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-error/30 bg-error-subtle rounded-lg p-3 mb-6">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      )}

      {/* Empty state */}
      {!loading && credentials.length === 0 && !error && (
        <EmptyState onAdd={() => setShowModal(true)} t={t} />
      )}

      {/* Credential list grouped by provider */}
      {!loading && providerKeys.length > 0 && (
        <div className="space-y-6">
          {providerKeys.map((provider) => (
            <div key={provider}>
              <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-2">
                {provider}
              </h2>
              <div className="space-y-2">
                {grouped[provider].map((cred) => (
                  <CredentialCard
                    key={cred.id}
                    credential={cred}
                    onDelete={handleDelete}
                    neverUsed={t('never_used')}
                    deleteAria={(name) => t('delete_aria', { name })}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add key modal */}
      <AddKeyModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleAdd}
        t={t}
      />
    </div>
  );
}
