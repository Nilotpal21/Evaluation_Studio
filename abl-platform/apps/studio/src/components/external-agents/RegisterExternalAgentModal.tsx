'use client';

import { useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/ErrorAlert';
import { ToggleChip } from '../ui/ToggleChip';
import {
  createExternalAgent,
  type ExternalAgentConfig,
  type CreateExternalAgentInput,
} from '../../api/external-agents';
import { sanitizeErrors } from '../../lib/sanitize-error';

interface RegisterExternalAgentModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onRegistered: (agent: ExternalAgentConfig) => void;
}

const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Sanitize a free-form string into a valid ABL identifier. */
function toAblName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[^a-zA-Z]+/, '')
    .replace(/_+/g, '_')
    .slice(0, 64)
    .trim();
}

interface DiscoveredCard {
  name: string;
  description?: string;
  protocol: 'a2a' | 'rest';
  skillCount: number;
}

interface FormErrors {
  endpoint?: string;
  name?: string;
  authValue?: string;
}

const INITIAL = {
  endpoint: '',
  authType: 'none' as 'none' | 'bearer' | 'api_key',
  authValue: '',
  authHeader: '',
  name: '',
  protocol: 'rest' as 'a2a' | 'rest',
};

export function RegisterExternalAgentModal({
  open,
  onClose,
  projectId,
  onRegistered,
}: RegisterExternalAgentModalProps) {
  const t = useTranslations('externalAgents.register_modal');

  const [form, setForm] = useState(INITIAL);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string[] | null>(null);

  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredCard | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Track the last endpoint we fetched so we don't re-fetch on every keystroke
  const lastDiscoveredEndpoint = useRef<string>('');

  const set = useCallback(<K extends keyof typeof INITIAL>(k: K, v: (typeof INITIAL)[K]) => {
    setForm((p) => ({ ...p, [k]: v }));
    setErrors((p) => ({ ...p, [k]: undefined }));
  }, []);

  const discoverCard = useCallback(
    async (endpoint: string) => {
      const url = endpoint.trim();
      if (!url || url === lastDiscoveredEndpoint.current) return;
      try {
        new URL(url);
      } catch {
        return;
      } // not a valid URL yet

      lastDiscoveredEndpoint.current = url;
      setDiscovering(true);
      setDiscovered(null);
      setDiscoverError(null);

      try {
        const base = url.replace(/\/+$/, '');
        const res = await fetch(`${base}/.well-known/agent-card.json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const card = await res.json();
        const d: DiscoveredCard = {
          name: card.name ?? '',
          description: card.description,
          protocol: 'a2a',
          skillCount: Array.isArray(card.skills) ? card.skills.length : 0,
        };
        setDiscovered(d);
        // Auto-fill name and protocol from card if user hasn't typed one
        setForm((p) => ({
          ...p,
          name: p.name || toAblName(d.name),
          protocol: 'a2a',
        }));
      } catch {
        // Card fetch failed — not an error, just no auto-fill
        setDiscoverError(t('discover_error'));
        setDiscovered(null);
      } finally {
        setDiscovering(false);
      }
    },
    [t],
  );

  const validate = useCallback((): boolean => {
    const errs: FormErrors = {};
    if (!form.endpoint.trim()) {
      errs.endpoint = t('validation.endpoint_required');
    } else {
      try {
        new URL(form.endpoint.trim());
      } catch {
        errs.endpoint = t('validation.endpoint_invalid');
      }
    }
    if (!form.name.trim()) {
      errs.name = t('validation.name_required');
    } else if (!NAME_REGEX.test(form.name.trim())) {
      errs.name = t('validation.name_invalid');
    }
    if (form.authType !== 'none' && !form.authValue.trim()) {
      errs.authValue = t('validation.auth_value_required');
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [form, t]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    setSaving(true);
    setApiError(null);
    try {
      const input: CreateExternalAgentInput = {
        name: form.name.trim(),
        displayName: discovered?.name ?? null,
        endpoint: form.endpoint.trim(),
        protocol: form.protocol,
        authType: form.authType,
        authConfig:
          form.authType !== 'none'
            ? {
                value: form.authValue,
                ...(form.authType === 'api_key' && form.authHeader.trim()
                  ? { header: form.authHeader.trim() }
                  : {}),
              }
            : null,
      };
      const res = await createExternalAgent(projectId, input);
      onRegistered(res.data);
      setForm(INITIAL);
      setDiscovered(null);
      setDiscoverError(null);
      lastDiscoveredEndpoint.current = '';
    } catch (err: unknown) {
      setApiError(sanitizeErrors(err, t('register_error')));
    } finally {
      setSaving(false);
    }
  }, [form, discovered, projectId, onRegistered, validate, t]);

  const handleClose = useCallback(() => {
    setForm(INITIAL);
    setErrors({});
    setApiError(null);
    setDiscovered(null);
    setDiscoverError(null);
    lastDiscoveredEndpoint.current = '';
    onClose();
  }, [onClose]);

  const showManualProtocol = !discovered && !discovering;

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} maxWidth="md">
      <div className="space-y-6">
        {apiError && <ErrorAlert error={apiError} onDismiss={() => setApiError(null)} />}

        {/* Step 1 — Endpoint */}
        <div className="space-y-1">
          <Input
            label={t('endpoint_url_label')}
            placeholder={t('endpoint_url_placeholder')}
            value={form.endpoint}
            onChange={(e) => set('endpoint', e.target.value)}
            onBlur={(e) => discoverCard(e.target.value)}
            error={errors.endpoint}
          />
          {/* Discovery feedback */}
          {discovering && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('discovering')}
            </p>
          )}
          {discovered && (
            <div className="flex items-start gap-2 rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
              <div>
                <span className="font-medium">{discovered.name}</span>
                {discovered.description && (
                  <span className="text-muted ml-1">— {discovered.description.slice(0, 80)}</span>
                )}
                <div className="text-muted mt-0.5">
                  {t('discovered_summary', { count: discovered.skillCount })}
                </div>
              </div>
            </div>
          )}
          {discoverError && (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <AlertCircle className="h-3 w-3" />
              {discoverError}
            </p>
          )}
        </div>

        {/* Manual protocol selector — only when card discovery failed */}
        {showManualProtocol && form.endpoint && (
          <div className="flex gap-2">
            {(['a2a', 'rest'] as const).map((p) => (
              <ToggleChip key={p} active={form.protocol === p} onClick={() => set('protocol', p)}>
                {p.toUpperCase()}
              </ToggleChip>
            ))}
          </div>
        )}

        {/* Step 2 — Registry name (shown after endpoint entered) */}
        {form.endpoint.trim() && (
          <div className="space-y-1">
            <Input
              label={t('registry_name_label')}
              placeholder={t('registry_name_placeholder')}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              error={errors.name}
            />
            <p className="text-xs text-muted">
              {t('handoff_hint_prefix')}{' '}
              <code className="font-mono bg-background-muted/40 px-1 rounded">
                {t('handoff_hint_command', {
                  agentName: form.name || t('handoff_hint_agent_fallback'),
                })}
              </code>
            </p>
          </div>
        )}

        {/* Step 3 — Auth (optional) */}
        {form.endpoint.trim() && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('authentication_label')}
            </p>
            <div className="flex gap-2">
              {(['none', 'bearer', 'api_key'] as const).map((a) => (
                <ToggleChip
                  key={a}
                  active={form.authType === a}
                  onClick={() => {
                    set('authType', a);
                    set('authValue', '');
                    set('authHeader', '');
                  }}
                >
                  {a === 'none'
                    ? t('auth_none')
                    : a === 'bearer'
                      ? t('auth_bearer')
                      : t('auth_api_key')}
                </ToggleChip>
              ))}
            </div>
            {form.authType !== 'none' && (
              <div className="space-y-2">
                <Input
                  label={form.authType === 'bearer' ? t('token_label') : t('key_label')}
                  placeholder={
                    form.authType === 'bearer' ? t('token_placeholder') : t('key_placeholder')
                  }
                  value={form.authValue}
                  onChange={(e) => set('authValue', e.target.value)}
                  error={errors.authValue}
                  type="password"
                />
                {form.authType === 'api_key' && (
                  <Input
                    label={t('header_name_optional_label')}
                    placeholder={t('header_name_placeholder')}
                    value={form.authHeader}
                    onChange={(e) => set('authHeader', e.target.value)}
                  />
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="secondary" onClick={handleClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={saving || !form.endpoint.trim()}
          >
            {saving ? t('registering') : t('submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
