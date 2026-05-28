/**
 * Agent Assist Settings Page
 *
 * Project-level Agent Assist management. Enable/disable at project level,
 * manage connections (bindings), generate/rotate API keys, and view the
 * Configuration modal with credentials for Kore Agent Assist.
 */

'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  Trash2,
  Copy,
  Check,
  Key,
  ExternalLink,
  Settings,
  Info,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Select';
import { Input } from '../ui/Input';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAgentAssistBindings, useAgentAssistSettings } from '../../hooks/useAgentAssistBindings';
import { useNavigationStore } from '../../store/navigation-store';
import type { AgentAssistBinding } from '../../api/agent-assist-bindings';

// =============================================================================
// Constants
// =============================================================================

const STUDIO_BASE_URL =
  typeof window !== 'undefined' ? process.env.NEXT_PUBLIC_STUDIO_URL || window.location.origin : '';

// =============================================================================
// Helper: Collapsible Section (matches AgentTransferSettingsPage pattern)
// =============================================================================

function ConfigSection({
  title,
  description,
  children,
  defaultOpen = true,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 bg-background-subtle hover:bg-background-muted transition-default text-left"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{description}</p>
        </div>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
        )}
      </button>
      {isOpen && <div className="p-4 space-y-4 border-t border-default">{children}</div>}
    </div>
  );
}

// =============================================================================
// Copy Field Helper
// =============================================================================

function CopyField({
  label,
  value,
  monospace = true,
  tooltip,
  t,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  tooltip?: string;
  t: (key: string) => string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t('agent_assist_copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available in all contexts
    }
  }, [value, t]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
        {tooltip && (
          <span className="relative group">
            <Info className="w-3 h-3 text-muted cursor-help" />
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-foreground bg-background border border-default rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap max-w-xs z-50">
              {tooltip}
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`flex-1 break-all text-xs text-foreground ${monospace ? 'font-mono' : ''}`}
        >
          {value}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 rounded p-1 text-muted hover:text-foreground hover:bg-background-muted transition-default"
          aria-label={t('agent_assist_copy_action')}
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Configuration Modal (C.2)
// =============================================================================

function AgentAssistConfigurationModal({
  open,
  onClose,
  binding,
  plaintextKey,
  onRegenerateKey,
  isRegenerating,
  t,
}: {
  open: boolean;
  onClose: () => void;
  binding: AgentAssistBinding | null;
  /** Non-null only right after create/regenerate; null after dismiss. */
  plaintextKey: string | null;
  onRegenerateKey: () => void;
  isRegenerating: boolean;
  t: (key: string) => string;
}) {
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyDismissed, setKeyDismissed] = useState(false);

  const domainUrl = STUDIO_BASE_URL;

  const handleCopyKey = useCallback(async () => {
    if (!plaintextKey) return;
    try {
      await navigator.clipboard.writeText(plaintextKey);
      setKeyCopied(true);
      toast.success(t('agent_assist_copied'));
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  }, [plaintextKey, t]);

  const handleClose = useCallback(() => {
    setKeyCopied(false);
    setKeyDismissed(false);
    onClose();
  }, [onClose]);

  if (!binding) return null;

  // Prefer the stored plaintext prefix (e.g. "abl_f931") so the fingerprint
  // matches the start of the key the user just copied. Fall back to the
  // internal apiKeyId last-4 for legacy bindings that predate the prefix field.
  const keyFingerprint = binding.apiKeyPrefix
    ? `${binding.apiKeyPrefix}…`
    : binding.apiKeyId
      ? `abl_****${binding.apiKeyId.substring(binding.apiKeyId.length - 4)}`
      : null;

  const showPlaintext = plaintextKey && !keyDismissed;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('agent_assist_configuration_title')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('agent_assist_configuration_description')}</p>

        <div className="space-y-3 rounded-lg border border-default bg-background-subtle p-4">
          <CopyField
            label={t('agent_assist_domain_url')}
            value={domainUrl}
            tooltip={t('agent_assist_domain_url_tooltip')}
            t={t}
          />
          <CopyField label={t('agent_assist_environment')} value={binding.environment} t={t} />
          <CopyField label={t('agent_assist_app_id')} value={binding.appId} t={t} />

          <div className="border-t border-default my-2" />

          {/* API Key section */}
          {showPlaintext ? (
            <div className="space-y-2">
              <Alert variant="warning">{t('agent_assist_key_last_time_warning')}</Alert>
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  {t('agent_assist_api_key_label')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all text-xs font-mono text-foreground bg-background rounded px-2 py-1.5 border border-default">
                    {plaintextKey}
                  </code>
                  <Button variant="secondary" size="sm" onClick={handleCopyKey}>
                    {keyCopied ? (
                      <Check className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setKeyDismissed(true)}
                className="w-full"
              >
                {t('agent_assist_key_copied_dismiss')}
              </Button>
            </div>
          ) : keyFingerprint ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {t('agent_assist_api_key_label')}
              </p>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs font-mono text-muted">{keyFingerprint}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onRegenerateKey}
                  loading={isRegenerating}
                  disabled={isRegenerating}
                >
                  {t('agent_assist_regenerate_key')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {t('agent_assist_api_key_label')}
              </p>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs text-muted italic">{t('agent_assist_no_key')}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onRegenerateKey}
                  loading={isRegenerating}
                  disabled={isRegenerating}
                  icon={<Key className="w-3.5 h-3.5" />}
                >
                  {t('agent_assist_generate_api_key')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <Alert variant="info">
          <span>{t('agent_assist_paste_into_kore')}</span>
        </Alert>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t('agent_assist_close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Add Connection Dialog (C.1)
// =============================================================================

function AddConnectionDialog({
  open,
  onClose,
  onCreated,
  t,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (binding: AgentAssistBinding) => void;
  t: (key: string) => string;
}) {
  const { projectId } = useNavigationStore();
  const { create } = useAgentAssistBindings();

  const [step, setStep] = useState<'picker' | 'form'>('picker');
  const [environment, setEnvironment] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!connectionName.trim() || !environment) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const binding = await create({
        environment: environment.trim(),
        displayName: connectionName.trim(),
      });
      toast.success(t('agent_assist_created_success'));
      handleReset();
      onCreated(binding);
    } catch (err) {
      const msg = sanitizeError(err, t('agent_assist_create_failed'));
      if (typeof msg === 'string' && msg.toLowerCase().includes('duplicate')) {
        setError(t('agent_assist_duplicate'));
      } else {
        setError(typeof msg === 'string' ? msg : t('agent_assist_create_failed'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setStep('picker');
    setEnvironment('');
    setConnectionName('');
    setError(null);
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('agent_assist_add_connection_title')}
      maxWidth="lg"
    >
      {step === 'picker' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('agent_assist_choose_provider')}</p>
          <div className="grid gap-3">
            {/* Kore Agent Assist */}
            <button
              onClick={() => setStep('form')}
              className="rounded-lg border-2 border-default bg-background-subtle p-4 text-left hover:border-border-focus transition-default"
            >
              <div className="flex items-center gap-2 mb-2">
                <ExternalLink className="w-5 h-5 text-foreground" />
                <span className="text-sm font-semibold text-foreground">
                  {t('agent_assist_provider_kore_label')}
                </span>
              </div>
              <p className="text-xs text-muted">{t('agent_assist_provider_kore_description')}</p>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Connection Name */}
          <Input
            label={t('agent_assist_connection_name')}
            type="text"
            value={connectionName}
            onChange={(e) => setConnectionName(e.target.value)}
            placeholder={t('agent_assist_connection_name_placeholder')}
            maxLength={100}
          />

          {/* Environment dropdown */}
          <div>
            <label className="text-xs font-medium text-foreground">
              {t('agent_assist_environment')}
            </label>
            <Select
              value={environment}
              onChange={setEnvironment}
              className="mt-1"
              options={[
                { value: '', label: t('agent_assist_environment_placeholder') },
                { value: 'dev', label: t('agent_assist_env_dev') },
                { value: 'staging', label: t('agent_assist_env_staging') },
                { value: 'production', label: t('agent_assist_env_production') },
              ]}
            />
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep('picker')}>
              {t('agent_assist_back')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              loading={isSubmitting}
              disabled={!connectionName.trim() || !environment || isSubmitting}
            >
              {isSubmitting ? t('agent_assist_creating') : t('agent_assist_create_connection')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// =============================================================================
// Main Section
// =============================================================================

export function AgentAssistSettingsPage() {
  const t = useTranslations('settings.agent_assist');
  const { projectId } = useNavigationStore();
  const { bindings, isLoading, error, disable, enable, remove, mintApiKey, refresh } =
    useAgentAssistBindings();
  const { settings, saveSettings, refresh: refreshSettings } = useAgentAssistSettings();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [configBinding, setConfigBinding] = useState<AgentAssistBinding | null>(null);
  const [configPlaintextKey, setConfigPlaintextKey] = useState<string | null>(null);
  const [deleteBinding, setDeleteBinding] = useState<AgentAssistBinding | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);

  const handleToggleEnabled = useCallback(
    async (checked: boolean) => {
      setIsTogglingEnabled(true);
      try {
        await saveSettings({ enabled: checked });
        toast.success(
          checked ? t('agent_assist_project_enabled') : t('agent_assist_project_disabled'),
        );
        refreshSettings();
      } catch (err) {
        toast.error(sanitizeError(err, t('agent_assist_toggle_failed')));
      } finally {
        setIsTogglingEnabled(false);
      }
    },
    [saveSettings, refreshSettings, t],
  );

  const handleToggleStatus = useCallback(
    async (binding: AgentAssistBinding) => {
      setTogglingId(binding._id);
      try {
        if (binding.status === 'active') {
          await disable(binding._id);
          toast.success(t('agent_assist_disabled'));
        } else {
          await enable(binding._id);
          toast.success(t('agent_assist_enabled'));
        }
      } catch (err) {
        toast.error(sanitizeError(err, t('agent_assist_toggle_failed')));
      } finally {
        setTogglingId(null);
      }
    },
    [disable, enable, t],
  );

  const handleConnectionCreated = useCallback(
    async (binding: AgentAssistBinding) => {
      // Close the Add dialog before opening the Configuration modal so it
      // doesn't remain behind the Configuration modal after the user dismisses it.
      setShowAddDialog(false);
      // Auto-generate API key and open Configuration modal
      try {
        const result = await mintApiKey(binding._id);
        await refresh();
        // Re-fetch to get updated binding with apiKeyId + prefix
        setConfigBinding({
          ...binding,
          apiKeyId: result.apiKeyId,
          apiKeyPrefix: result.prefix,
        });
        setConfigPlaintextKey(result.rawKey);
      } catch (err) {
        // If key generation fails, still open config modal
        await refresh();
        setConfigBinding(binding);
        setConfigPlaintextKey(null);
        toast.error(sanitizeError(err, t('agent_assist_api_key_failed')));
      }
    },
    [mintApiKey, refresh, t],
  );

  const handleOpenConfiguration = useCallback((binding: AgentAssistBinding) => {
    setConfigBinding(binding);
    setConfigPlaintextKey(null);
  }, []);

  const handleRegenerateKey = useCallback(async () => {
    if (!configBinding) return;
    setIsRegenerating(true);
    try {
      const result = await mintApiKey(configBinding._id);
      setConfigPlaintextKey(result.rawKey);
      setConfigBinding((prev) =>
        prev ? { ...prev, apiKeyId: result.apiKeyId, apiKeyPrefix: result.prefix } : null,
      );
      await refresh();
      toast.success(
        configBinding.apiKeyId
          ? t('agent_assist_api_key_rotated')
          : t('agent_assist_api_key_generated'),
      );
    } catch (err) {
      toast.error(sanitizeError(err, t('agent_assist_api_key_failed')));
    } finally {
      setIsRegenerating(false);
    }
  }, [configBinding, mintApiKey, refresh, t]);

  const handleDelete = useCallback(async () => {
    if (!deleteBinding) return;
    setIsDeleting(true);
    try {
      await remove(deleteBinding._id);
      toast.success(t('agent_assist_deleted'));
      setDeleteBinding(null);
    } catch (err) {
      toast.error(sanitizeError(err, t('agent_assist_delete_failed')));
    } finally {
      setIsDeleting(false);
    }
  }, [deleteBinding, remove, t]);

  const isDisabled = !settings.enabled;

  return (
    <>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted mt-1">{t('description')}</p>
          </div>
        </div>

        {/* Error banner */}
        {error && <Alert variant="error">{t('agent_assist_load_failed')}</Alert>}

        {/* Project Settings */}
        <ConfigSection
          title={t('section_project_settings')}
          description={t('section_project_settings_description')}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('agent_assist_enable_label')}
              </p>
              <p className="text-xs text-muted mt-0.5">{t('agent_assist_enable_description')}</p>
            </div>
            <Toggle
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              disabled={isTogglingEnabled}
              ariaLabel={t('agent_assist_enable_label')}
            />
          </div>
        </ConfigSection>

        {/* Connections */}
        <ConfigSection
          title={t('section_connections')}
          description={t('section_connections_description')}
        >
          {/* Add button row */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">
              {bindings.length > 0
                ? `${bindings.length} ${t('agent_assist_connection_count')}`
                : ''}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAddDialog(true)}
              disabled={isDisabled}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              {t('agent_assist_add_connection')}
            </Button>
          </div>

          {/* Loading */}
          {isLoading && bindings.length === 0 && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 text-muted animate-spin" />
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && bindings.length === 0 && (
            <EmptyState
              icon={<ExternalLink className="w-6 h-6" />}
              title={t('agent_assist_no_connections')}
              description={t('agent_assist_no_connections_description')}
            />
          )}

          {/* Connections table */}
          {bindings.length > 0 && (
            <div
              className={`rounded-lg border border-default overflow-hidden ${isDisabled ? 'opacity-60 pointer-events-none' : ''}`}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-background-subtle border-b border-default">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_col_name')}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_environment')}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_status')}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_col_api_key')}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_created')}
                    </th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted">
                      {t('agent_assist_actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bindings.map((binding) => (
                    <tr key={binding._id} className="border-b border-default last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <ExternalLink className="w-3.5 h-3.5 text-muted" />
                          <span className="text-xs text-foreground">
                            {binding.displayName || t('agent_assist_provider_kore_label')}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{binding.environment}</td>
                      <td className="px-4 py-3">
                        <Badge variant={binding.status === 'active' ? 'success' : 'default'} dot>
                          {binding.status === 'active'
                            ? t('agent_assist_status_active')
                            : t('agent_assist_status_disabled')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground font-mono">
                        {binding.apiKeyPrefix ? (
                          <span className="text-muted">{binding.apiKeyPrefix}…</span>
                        ) : binding.apiKeyId ? (
                          <span className="text-muted">
                            abl_{'*'.repeat(4)}
                            {binding.apiKeyId.substring(binding.apiKeyId.length - 4)}
                          </span>
                        ) : (
                          <span className="text-muted italic">{t('agent_assist_no_key')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {new Date(binding.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenConfiguration(binding)}
                            aria-label={t('agent_assist_configuration_action')}
                          >
                            <Settings className="w-3.5 h-3.5" />
                          </Button>
                          <Toggle
                            checked={binding.status === 'active'}
                            onChange={() => handleToggleStatus(binding)}
                            disabled={togglingId === binding._id}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteBinding(binding)}
                            aria-label={t('agent_assist_delete_confirm_title')}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-error" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ConfigSection>
      </div>

      {/* Add connection dialog */}
      <AddConnectionDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onCreated={handleConnectionCreated}
        t={t}
      />

      {/* Configuration modal */}
      <AgentAssistConfigurationModal
        open={configBinding !== null}
        onClose={() => {
          setConfigBinding(null);
          setConfigPlaintextKey(null);
        }}
        binding={configBinding}
        plaintextKey={configPlaintextKey}
        onRegenerateKey={handleRegenerateKey}
        isRegenerating={isRegenerating}
        t={t}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteBinding !== null}
        onClose={() => setDeleteBinding(null)}
        onConfirm={handleDelete}
        title={t('agent_assist_delete_confirm_title')}
        description={t('agent_assist_delete_confirm_description')}
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
