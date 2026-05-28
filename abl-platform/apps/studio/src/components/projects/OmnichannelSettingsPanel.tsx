/**
 * OmnichannelSettingsPanel Component
 *
 * Project settings panel for managing omnichannel session continuity configuration.
 * Controls for recall, identity verification, consent, and live transcript sync.
 * Follows the AttachmentSettingsTab pattern: direct apiFetch + useState, no SWR.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Radio, Loader2, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OmnichannelFormState {
  recall: {
    enabled: boolean;
    maxMessages: number;
    maxAgeDays: number;
    allowedChannels: string[];
  };
  identity: {
    requireVerification: boolean;
    minTier: number;
  };
  consent: {
    requireExplicitConsent: boolean;
  };
  liveSync: {
    enabled: boolean;
    joinMode: 'prompt' | 'auto';
    transcriptMode: 'final_only';
  };
}

const DEFAULT_STATE: OmnichannelFormState = {
  recall: {
    enabled: false,
    maxMessages: 20,
    maxAgeDays: 30,
    allowedChannels: [],
  },
  identity: {
    requireVerification: true,
    minTier: 2,
  },
  consent: {
    requireExplicitConsent: true,
  },
  liveSync: {
    enabled: false,
    joinMode: 'prompt',
    transcriptMode: 'final_only',
  },
};

const AVAILABLE_CHANNELS = ['web', 'voice', 'sms', 'whatsapp', 'email', 'slack', 'teams'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapResponseToFormState(data: Record<string, unknown>): OmnichannelFormState {
  const recall = (data.recall as Record<string, unknown>) ?? {};
  const identity = (data.identity as Record<string, unknown>) ?? {};
  const consent = (data.consent as Record<string, unknown>) ?? {};
  const liveSync = (data.liveSync as Record<string, unknown>) ?? {};

  return {
    recall: {
      enabled: typeof recall.enabled === 'boolean' ? recall.enabled : DEFAULT_STATE.recall.enabled,
      maxMessages:
        typeof recall.maxMessages === 'number'
          ? recall.maxMessages
          : DEFAULT_STATE.recall.maxMessages,
      maxAgeDays:
        typeof recall.maxAgeDays === 'number' ? recall.maxAgeDays : DEFAULT_STATE.recall.maxAgeDays,
      allowedChannels: Array.isArray(recall.allowedChannels)
        ? (recall.allowedChannels as string[])
        : DEFAULT_STATE.recall.allowedChannels,
    },
    identity: {
      requireVerification:
        typeof identity.requireVerification === 'boolean'
          ? identity.requireVerification
          : DEFAULT_STATE.identity.requireVerification,
      minTier:
        typeof identity.minTier === 'number' ? identity.minTier : DEFAULT_STATE.identity.minTier,
    },
    consent: {
      requireExplicitConsent:
        typeof consent.requireExplicitConsent === 'boolean'
          ? consent.requireExplicitConsent
          : DEFAULT_STATE.consent.requireExplicitConsent,
    },
    liveSync: {
      enabled:
        typeof liveSync.enabled === 'boolean' ? liveSync.enabled : DEFAULT_STATE.liveSync.enabled,
      joinMode:
        liveSync.joinMode === 'prompt' || liveSync.joinMode === 'auto'
          ? liveSync.joinMode
          : DEFAULT_STATE.liveSync.joinMode,
      transcriptMode: 'final_only',
    },
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function OmnichannelSettingsPanel() {
  const t = useTranslations('settings.omnichannel');
  const projectId = useNavigationStore((s) => s.projectId);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [formState, setFormState] = useState<OmnichannelFormState>(DEFAULT_STATE);
  const [initialState, setInitialState] = useState<OmnichannelFormState>(DEFAULT_STATE);

  // ─── Load ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/omnichannel`);
      if (res.ok) {
        const { data } = await res.json();
        if (data) {
          const state = mapResponseToFormState(data);
          setFormState(state);
          setInitialState(state);
        }
        // data is null → use defaults (already set)
        setIsDirty(false);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]); // t is stable in next-intl

  useEffect(() => {
    load();
  }, [load]);

  // ─── Save ───────────────────────────────────────────────────────────────

  const save = async () => {
    if (!projectId || !isDirty || isSaving) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/omnichannel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formState),
      });
      if (res.ok) {
        const { data } = await res.json();
        if (data) {
          const state = mapResponseToFormState(data);
          setFormState(state);
          setInitialState(state);
        } else {
          setInitialState(formState);
        }
        setIsDirty(false);
        toast.success(t('saved'));
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Field Updates ──────────────────────────────────────────────────────

  const updateRecall = <K extends keyof OmnichannelFormState['recall']>(
    key: K,
    value: OmnichannelFormState['recall'][K],
  ) => {
    setFormState((prev) => ({ ...prev, recall: { ...prev.recall, [key]: value } }));
    setIsDirty(true);
  };

  const updateIdentity = <K extends keyof OmnichannelFormState['identity']>(
    key: K,
    value: OmnichannelFormState['identity'][K],
  ) => {
    setFormState((prev) => ({ ...prev, identity: { ...prev.identity, [key]: value } }));
    setIsDirty(true);
  };

  const updateConsent = <K extends keyof OmnichannelFormState['consent']>(
    key: K,
    value: OmnichannelFormState['consent'][K],
  ) => {
    setFormState((prev) => ({ ...prev, consent: { ...prev.consent, [key]: value } }));
    setIsDirty(true);
  };

  const updateLiveSync = <K extends keyof OmnichannelFormState['liveSync']>(
    key: K,
    value: OmnichannelFormState['liveSync'][K],
  ) => {
    setFormState((prev) => ({ ...prev, liveSync: { ...prev.liveSync, [key]: value } }));
    setIsDirty(true);
  };

  const toggleChannel = (channel: string) => {
    const current = formState.recall.allowedChannels;
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    updateRecall('allowedChannels', next);
  };

  // ─── Render Helpers ─────────────────────────────────────────────────────

  // ─── Loading State ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-foreground-muted" />
        </div>
      </div>
    );
  }

  // ─── Main Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Radio className="w-5 h-5 text-accent-primary mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="text-xs text-foreground-muted mt-1">{t('description')}</p>
        </div>
        <Button onClick={save} disabled={!isDirty || isSaving} size="sm" variant="primary">
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {isSaving ? t('saving') : t('save')}
        </Button>
      </div>

      {/* Section: Conversation Recall */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {t('recall.title')}
        </h4>

        {/* Recall enabled toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-background">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('recall.enabled')}</p>
          </div>
          <Toggle
            checked={formState.recall.enabled}
            onChange={(val) => updateRecall('enabled', val)}
            ariaLabel={t('recall.enabled')}
          />
        </div>

        {/* Max Messages */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('recall.maxMessages')}</p>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={formState.recall.maxMessages}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) {
                updateRecall('maxMessages', val);
              }
            }}
            aria-label={t('recall.maxMessages')}
            className="w-24 px-3 py-1.5 text-sm rounded-lg border border-border-subtle bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary"
          />
        </div>

        {/* Max Age Days */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('recall.maxAgeDays')}</p>
          <input
            type="number"
            min="1"
            max="365"
            step="1"
            value={formState.recall.maxAgeDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) {
                updateRecall('maxAgeDays', val);
              }
            }}
            aria-label={t('recall.maxAgeDays')}
            className="w-24 px-3 py-1.5 text-sm rounded-lg border border-border-subtle bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary"
          />
        </div>

        {/* Allowed Channels */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('recall.allowedChannels')}</p>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_CHANNELS.map((channel) => {
              const isSelected = formState.recall.allowedChannels.includes(channel);
              return (
                <button
                  key={channel}
                  onClick={() => toggleChannel(channel)}
                  aria-label={`${channel} channel`}
                  aria-pressed={isSelected}
                  className={clsx(
                    'px-3 py-1 text-xs font-medium rounded-md border transition-default',
                    isSelected
                      ? 'bg-accent-subtle text-accent-primary border-accent'
                      : 'bg-background text-foreground-muted border-border-subtle hover:border-border hover:text-foreground',
                  )}
                >
                  {channel}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Section: Identity Requirements */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {t('identity.title')}
        </h4>

        {/* Require Verification toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-background">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              {t('identity.requireVerification')}
            </p>
          </div>
          <Toggle
            checked={formState.identity.requireVerification}
            onChange={(val) => updateIdentity('requireVerification', val)}
            ariaLabel={t('identity.requireVerification')}
          />
        </div>

        {/* Min Tier */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('identity.minTier')}</p>
          <select
            value={formState.identity.minTier}
            onChange={(e) => updateIdentity('minTier', parseInt(e.target.value, 10))}
            aria-label={t('identity.minTier')}
            className="w-48 px-3 py-1.5 text-sm rounded-lg border border-border-subtle bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary"
          >
            <option value={0}>{t('identity.tier0')}</option>
            <option value={1}>{t('identity.tier1')}</option>
            <option value={2}>{t('identity.tier2')}</option>
          </select>
        </div>
      </div>

      {/* Section: Consent */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {t('consent.title')}
        </h4>

        {/* Require Explicit Consent toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-background">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              {t('consent.requireExplicitConsent')}
            </p>
          </div>
          <Toggle
            checked={formState.consent.requireExplicitConsent}
            onChange={(val) => updateConsent('requireExplicitConsent', val)}
            ariaLabel={t('consent.requireExplicitConsent')}
          />
        </div>
      </div>

      {/* Section: Live Transcript Sync */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {t('liveSync.title')}
        </h4>

        {/* Live Sync enabled toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-background">
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('liveSync.enabled')}</p>
          </div>
          <Toggle
            checked={formState.liveSync.enabled}
            onChange={(val) => updateLiveSync('enabled', val)}
            ariaLabel={t('liveSync.enabled')}
          />
        </div>

        {/* Join Mode */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('liveSync.joinMode')}</p>
          <select
            value={formState.liveSync.joinMode}
            onChange={(e) => updateLiveSync('joinMode', e.target.value as 'prompt' | 'auto')}
            aria-label={t('liveSync.joinMode')}
            className="w-48 px-3 py-1.5 text-sm rounded-lg border border-border-subtle bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary"
          >
            <option value="prompt">{t('liveSync.joinModePrompt')}</option>
            <option value="auto">{t('liveSync.joinModeAuto')}</option>
          </select>
        </div>

        {/* Transcript Mode */}
        <div className="p-3 rounded-lg border border-border-subtle bg-background space-y-2">
          <p className="text-sm font-medium text-foreground">{t('liveSync.transcriptMode')}</p>
          <select
            value={formState.liveSync.transcriptMode}
            onChange={() => {
              /* final_only is the only option for Phase 1 */
            }}
            aria-label={t('liveSync.transcriptMode')}
            disabled
            className="w-48 px-3 py-1.5 text-sm rounded-lg border border-border-subtle bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary disabled:opacity-50"
          >
            <option value="final_only">{t('liveSync.transcriptModeFinalOnly')}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
