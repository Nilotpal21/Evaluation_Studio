'use client';

/**
 * API Keys Slide-Out Panel
 *
 * Personal credentials management for playground and testing.
 * Renders as a right slide-out panel triggered from the UserMenu.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { Key, Plus, Trash2, X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { springs } from '../../lib/animation';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';

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

function KeyStatusDot({ isActive }: { isActive: boolean }) {
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
    <div className="border border-default rounded-lg p-3 bg-background-muted flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Key className="w-4 h-4 text-muted shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{credential.name}</span>
            <ProviderBadge provider={credential.provider} />
            <KeyStatusDot isActive={credential.isActive} />
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

// ---------------------------------------------------------------------------
// Add Key Form (inline)
// ---------------------------------------------------------------------------

function AddKeyForm({
  onSubmit,
  onCancel,
  t,
}: {
  onSubmit: (data: {
    name: string;
    provider: Provider;
    apiKey: string;
    endpoint?: string;
    authConfig?: Record<string, unknown>;
  }) => Promise<void>;
  onCancel: () => void;
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
      onCancel();
    } catch (err) {
      setError(sanitizeError(err, t('failed_to_add')));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClasses =
    'rounded-md border border-default bg-background px-3 py-2 text-sm w-full focus:outline-none focus-ring';

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-default rounded-lg p-4 bg-background space-y-3"
    >
      <div>
        <label className="text-sm font-medium text-foreground block mb-1">{t('label_name')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('placeholder_name')}
          className={inputClasses}
          required
        />
      </div>

      <div>
        <Select
          label={t('label_provider')}
          options={PROVIDERS}
          value={provider}
          onChange={(v) => setProvider(v as Provider)}
        />
      </div>

      <div>
        <label className="text-sm font-medium text-foreground block mb-1">
          {t('label_api_key')}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('placeholder_api_key')}
          className={inputClasses}
          required
        />
      </div>

      {showEndpoint && (
        <div>
          <label className="text-sm font-medium text-foreground block mb-1">
            {t('label_endpoint_url')}
            {provider !== 'microsoft_foundry_anthropic' && (
              <span className="text-muted font-normal ml-1">{t('label_optional')}</span>
            )}
          </label>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={
              provider === 'microsoft_foundry_anthropic'
                ? 'https://<resource>.services.ai.azure.com/anthropic'
                : t('placeholder_endpoint')
            }
            className={inputClasses}
            required={provider === 'microsoft_foundry_anthropic'}
          />
        </div>
      )}

      {provider === 'microsoft_foundry_anthropic' && (
        <div>
          <label className="text-sm font-medium text-foreground block mb-1">
            {t('label_anthropic_version')}
            <span className="text-muted font-normal ml-1">{t('label_optional')}</span>
          </label>
          <input
            type="text"
            value={foundryAnthropicVersion}
            onChange={(e) => setFoundryAnthropicVersion(e.target.value)}
            placeholder={t('placeholder_anthropic_version')}
            className={inputClasses}
          />
        </div>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" onClick={onCancel} variant="ghost" size="sm">
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
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
  );
}

// ---------------------------------------------------------------------------
// Slide-Out Panel
// ---------------------------------------------------------------------------

export function ApiKeysModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const t = useTranslations('settings.personal_api_keys');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

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
    if (isOpen) {
      setLoading(true);
      fetchCredentials();
    } else {
      setShowAddForm(false);
    }
  }, [isOpen, fetchCredentials]);

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
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Slide-out panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
            className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-md bg-background-elevated border-l border-default shadow-xl flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
                <p className="text-xs text-muted mt-0.5">{t('description')}</p>
              </div>
              <div className="flex items-center gap-2">
                {credentials.length > 0 && !showAddForm && (
                  <Button
                    onClick={() => setShowAddForm(true)}
                    size="xs"
                    variant="primary"
                    icon={<Plus className="w-3.5 h-3.5" />}
                  >
                    {t('add')}
                  </Button>
                )}
                <button
                  onClick={onClose}
                  className="text-muted hover:text-foreground transition-default p-1.5 rounded-md hover:bg-background-muted"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Error */}
              {error && (
                <div className="border border-error/30 bg-error-subtle rounded-lg p-3 mb-4">
                  <p className="text-sm text-error">{error}</p>
                </div>
              )}

              {/* Add form */}
              {showAddForm && (
                <div className="mb-4">
                  <AddKeyForm onSubmit={handleAdd} onCancel={() => setShowAddForm(false)} t={t} />
                </div>
              )}

              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 animate-spin text-muted" />
                </div>
              )}

              {/* Empty state */}
              {!loading && credentials.length === 0 && !error && !showAddForm && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-10 h-10 rounded-full bg-background-muted flex items-center justify-center mb-3">
                    <Key className="w-5 h-5 text-muted" />
                  </div>
                  <h3 className="text-sm font-medium text-foreground mb-1">{t('empty_title')}</h3>
                  <p className="text-xs text-muted mb-3 max-w-xs">{t('empty_description')}</p>
                  <Button
                    onClick={() => setShowAddForm(true)}
                    variant="primary"
                    icon={<Plus className="w-4 h-4" />}
                  >
                    {t('add_key')}
                  </Button>
                </div>
              )}

              {/* Credential list grouped by provider */}
              {!loading && providerKeys.length > 0 && (
                <div className="space-y-4">
                  {providerKeys.map((provider) => (
                    <div key={provider}>
                      <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
                        {provider}
                      </h3>
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
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
