/**
 * ConfigurationTab — channel-specific settings.
 *
 * Uses strategy pattern: different form sections based on channel category.
 */

'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  Check,
  ChevronDown,
  Globe,
  Info,
  MessageSquare,
  Mic,
  RefreshCw,
  Search,
  Shield,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Checkbox';
import { Select } from '../../../ui/Select';
import { RadioGroup } from '../../../ui/RadioGroup';
import { SearchableSelect } from '../../../ui/SearchableSelect';
import {
  searchAvailableNumbers,
  purchasePhoneNumber,
  fetchSbcAddresses,
  type AvailablePhoneNumber,
} from '../../../../api/voice';
import {
  fetchConfiguredSpeechProviders,
  fetchSpeechOptions,
  type SpeechProvider,
  type SpeechOptions,
} from '../../../../api/speech-providers';
import { TTSPreview } from '../../../voice/TTSPreview';
import { useAuthStore } from '../../../../store/auth-store';
import { Toggle } from '../../../ui/Toggle';
import { CodeBlock } from '../../../ui/CodeBlock';
import {
  fetchSdkJweCapability,
  updateChannel,
  type SDKJweCapability,
  type SDKTokenEnvelopePolicy,
} from '../../../../api/channels';
import { updateConnection } from '../../../../api/channel-connections';
import { updateSubscription } from '../../../../api/http-async-channels';
import { readSdkChannelShowActivityUpdates } from '@/lib/sdk-channel-display-config';
import { sanitizeError } from '../../../../lib/sanitize-error';
import type { ChannelTabProps, ChannelTypeDef, ChannelInstance, ChannelTypeId } from '../types';
import { getActiveProviderOption } from '../channel-registry';
import { S2SProviderSelector } from '../S2SProviderSelector';
import { S2SConfigFields } from '../S2SConfigFields';
import {
  normalizeActiveS2SProviderConfig,
  normalizeS2SProviderConfig,
} from '../s2s-provider-config';

// =============================================================================
// CONSTANTS
// =============================================================================

const AVAILABLE_EVENT_IDS = [
  'agent.response',
  'session.created',
  'session.ended',
  'handoff.requested',
  'escalation.triggered',
] as const;

const EVENT_LABEL_KEYS: Record<string, string> = {
  'agent.response': 'event_agent_response',
  'session.created': 'event_session_created',
  'session.ended': 'event_session_ended',
  'handoff.requested': 'event_handoff_requested',
  'escalation.triggered': 'event_escalation_triggered',
};

const VOICE_PROVIDERS = [
  { value: 'kore_vgw', label: 'Kore.ai Voice Gateway' },
  { value: 'byoc_sip', label: 'Bring Your Own SIP' },
] as const;

const SIP_TRANSPORT_OPTIONS = [
  { value: 'udp', label: 'UDP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'tls', label: 'TLS' },
] as const;

const PHONE_NUMBER_PROVIDERS = [
  { value: 'twilio', label: 'Twilio' },
  { value: 'telnyx', label: 'Telnyx' },
] as const;

const REALTIME_MODELS = [
  { value: 'openai_realtime', label: 'OpenAI Realtime' },
  { value: 'gemini_live', label: 'Gemini Live' },
] as const;

const COUNTRY_OPTIONS = [
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
] as const;

const NUMBER_TYPE_OPTIONS = [
  { value: 'local', label: 'Local' },
  { value: 'tollFree', label: 'Toll-Free' },
] as const;

const ORPHEUS_TTS_VENDOR = 'custom:orpheus';
const ELEVENLABS_TTS_VENDOR = 'elevenlabs';
const MICROSOFT_SPEECH_VENDOR = 'microsoft';

const ELEVENLABS_CHANNEL_TTS_RANGE_SETTINGS = [
  {
    key: 'ttsSpeed',
    label: 'Speed',
    defaultValue: 1,
    min: 0.7,
    max: 1.2,
    step: 0.05,
    helper:
      'Adjusts speaking pace. 1.0 is normal; lower slows the voice down, higher makes it faster.',
  },
  {
    key: 'ttsStability',
    label: 'Stability',
    defaultValue: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    helper:
      'Controls consistency across generations. Higher is more stable and less expressive; lower allows more variation.',
  },
  {
    key: 'ttsSimilarityBoost',
    label: 'Similarity boost',
    defaultValue: 0.75,
    min: 0,
    max: 1,
    step: 0.05,
    helper:
      'Keeps the output closer to the selected voice. Higher values preserve more of the original voice character.',
  },
  {
    key: 'ttsStyle',
    label: 'Style exaggeration',
    defaultValue: 0,
    min: 0,
    max: 1,
    step: 0.05,
    helper:
      'Amplifies voice style and emotion. Higher values can sound more expressive but may increase latency or instability.',
  },
] as const;

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function getProviderConfigString(
  provider: SpeechProvider | undefined,
  key: string,
): string | undefined {
  const value = provider?.config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getConfigNumber(
  config: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const value = config[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

function normalizeStringList(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  return rawItems
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

interface SearchableMultiSelectOption {
  value: string;
  label: string;
}

interface TtsVoiceOption {
  value: string;
  label: string;
  languageCode: string;
  languageName: string;
}

function buildTtsVoiceOptions(options: SpeechOptions): TtsVoiceOption[] {
  return options.tts.flatMap((language) =>
    language.voices.map((voice) => ({
      value: voice.value,
      label: `${voice.name} · ${language.code}`,
      languageCode: language.code,
      languageName: language.name,
    })),
  );
}

function SearchableMultiSelect({
  label,
  options,
  value,
  onChange,
  disabled,
  placeholder = 'Select...',
}: {
  label: string;
  options: SearchableMultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedOptions = options.filter((option) => value.includes(option.value));
  const filteredOptions = search
    ? options.filter((option) =>
        `${option.label} ${option.value}`.toLowerCase().includes(search.toLowerCase()),
      )
    : options;
  const selectId = label.toLowerCase().replace(/\s+/g, '-');
  const summary =
    selectedOptions.length === 0
      ? placeholder
      : selectedOptions.length <= 2
        ? selectedOptions.map((option) => option.label).join(', ')
        : `${selectedOptions.length} languages selected`;

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const toggleValue = (selectedValue: string) => {
    if (value.includes(selectedValue)) {
      onChange(value.filter((item) => item !== selectedValue));
    } else {
      onChange([...value, selectedValue]);
    }
  };

  return (
    <div className="space-y-1.5" ref={containerRef}>
      <label htmlFor={selectId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <button
          type="button"
          id={selectId}
          disabled={disabled}
          onClick={() => !disabled && setOpen((prev) => !prev)}
          className="w-full flex items-center justify-between rounded-lg border border-default bg-background text-foreground transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 pl-3 pr-8 text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className={selectedOptions.length === 0 ? 'text-subtle' : ''}>{summary}</span>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-default bg-background-elevated shadow-xl animate-fade-in-scale">
            <div className="flex items-center gap-2 border-b border-default px-3 py-2">
              <Search className="w-3.5 h-3.5 text-muted shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">No results</p>
              ) : (
                filteredOptions.map((option) => {
                  const selected = value.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleValue(option.value)}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-foreground-muted hover:bg-background-muted hover:text-foreground transition-default"
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded border border-default bg-background">
                        {selected && <Check className="h-3 w-3 text-primary" />}
                      </span>
                      <span className="min-w-0 truncate">{option.label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedOptions.map((option) => (
            <span
              key={option.value}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-default bg-background px-2 py-1 text-xs text-foreground"
            >
              <span className="truncate">{option.label}</span>
              <button
                type="button"
                aria-label={`Remove ${option.label}`}
                onClick={() => toggleValue(option.value)}
                className="text-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function findPreferredSpeechProvider(
  providers: SpeechProvider[],
  serviceInstanceId: unknown,
  serviceType: unknown,
): SpeechProvider | undefined {
  if (typeof serviceInstanceId === 'string') {
    const exact = providers.find((provider) => provider.id === serviceInstanceId);
    if (exact) {
      return exact;
    }
  }

  if (typeof serviceType === 'string' && serviceType.length > 0) {
    const sameTypeDefault =
      providers.find((provider) => provider.serviceType === serviceType && provider.isDefault) ||
      providers.find((provider) => provider.serviceType === serviceType);
    if (sameTypeDefault) {
      return sameTypeDefault;
    }
  }

  return providers.find((provider) => provider.isDefault) || providers[0];
}

// =============================================================================
// CHANNEL-SPECIFIC SECTIONS
// =============================================================================

function MessagingFields({
  channelDef,
  instance,
  externalId,
  setExternalId,
  errors,
  cannotChangeLabel,
}: {
  channelDef: ChannelTypeDef;
  instance: ChannelInstance;
  externalId: string;
  setExternalId: (v: string) => void;
  errors: Record<string, string>;
  cannotChangeLabel: string;
}) {
  if (channelDef.capabilities.autoGenerateIdentifier) {
    return null;
  }

  const alreadySet = Boolean(instance.externalIdentifier);
  const providerOption = getActiveProviderOption(channelDef, instance);

  return (
    <div>
      <Input
        label={providerOption?.externalIdentifierLabel || channelDef.externalIdentifierLabel}
        placeholder={
          providerOption?.externalIdentifierPlaceholder || channelDef.externalIdentifierPlaceholder
        }
        value={externalId}
        onChange={(e) => setExternalId(e.target.value)}
        disabled={alreadySet}
        error={errors.externalId}
      />
      {alreadySet && <p className="text-xs text-muted mt-1.5">{cannotChangeLabel}</p>}
    </div>
  );
}

function SlackStreamingFields({
  streamingEnabled,
  setStreamingEnabled,
  chunkSize,
  setChunkSize,
}: {
  streamingEnabled: boolean;
  setStreamingEnabled: (v: boolean) => void;
  chunkSize: string;
  setChunkSize: (v: string) => void;
}) {
  const t = useTranslations('channels.config');

  return (
    <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        {t('streaming_title')}
      </h5>
      <p className="text-xs text-muted">{t('streaming_description')}</p>

      <div className="flex items-center justify-between">
        <span className="text-sm text-foreground">{t('streaming_enabled_label')}</span>
        <Toggle checked={streamingEnabled} onChange={setStreamingEnabled} />
      </div>

      {streamingEnabled && (
        <div>
          <Input
            label={t('streaming_chunk_size_label')}
            placeholder={t('streaming_chunk_size_placeholder')}
            value={chunkSize}
            onChange={(e) => setChunkSize(e.target.value)}
          />
          <p className="text-xs text-muted mt-1.5">{t('streaming_chunk_size_hint')}</p>
        </div>
      )}
    </div>
  );
}

function EmailTemplateFields({
  emailHeader,
  setEmailHeader,
  emailFooter,
  setEmailFooter,
  csatEnabled,
  setCsatEnabled,
  emailTransport,
  setEmailTransport,
  graphTenantId,
  setGraphTenantId,
  graphClientId,
  setGraphClientId,
  graphSenderAddress,
  setGraphSenderAddress,
  graphClientSecret,
  setGraphClientSecret,
  hasExistingGraphSecret,
  errors = {},
}: {
  emailHeader: string;
  setEmailHeader: (v: string) => void;
  emailFooter: string;
  setEmailFooter: (v: string) => void;
  csatEnabled: boolean;
  setCsatEnabled: (v: boolean) => void;
  emailTransport: string;
  setEmailTransport: (v: string) => void;
  graphTenantId: string;
  setGraphTenantId: (v: string) => void;
  graphClientId: string;
  setGraphClientId: (v: string) => void;
  graphSenderAddress: string;
  setGraphSenderAddress: (v: string) => void;
  graphClientSecret: string;
  setGraphClientSecret: (v: string) => void;
  hasExistingGraphSecret: boolean;
  errors?: Record<string, string>;
}) {
  return (
    <>
      {/* Outbound Transport */}
      <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
        <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Outbound Transport
        </h5>
        <Select
          label="Provider"
          options={[
            { value: 'smtp', label: 'SMTP (Default)' },
            { value: 'graph', label: 'Microsoft Graph API' },
          ]}
          value={emailTransport}
          onChange={setEmailTransport}
        />
        {emailTransport === 'graph' && (
          <div className="space-y-3 pt-2">
            <p className="text-xs text-muted">
              Configure Azure AD app registration credentials for sending email via Microsoft Graph
              API.
            </p>
            <Input
              label="Azure AD Tenant ID"
              placeholder="e.g. 12345678-abcd-1234-abcd-1234567890ab"
              value={graphTenantId}
              onChange={(e) => setGraphTenantId(e.target.value)}
              error={errors.graphTenantId}
            />
            <Input
              label="Application (Client) ID"
              placeholder="e.g. abcdef01-2345-6789-abcd-ef0123456789"
              value={graphClientId}
              onChange={(e) => setGraphClientId(e.target.value)}
              error={errors.graphClientId}
            />
            <Input
              label="Sender Mailbox Address"
              placeholder="e.g. agent@company.com"
              value={graphSenderAddress}
              onChange={(e) => setGraphSenderAddress(e.target.value)}
              error={errors.graphSenderAddress}
            />
            <div>
              <Input
                label="Client Secret"
                type="password"
                placeholder={
                  hasExistingGraphSecret
                    ? '••••••••  (leave blank to keep current)'
                    : 'Enter client secret'
                }
                value={graphClientSecret}
                onChange={(e) => setGraphClientSecret(e.target.value)}
                error={errors.graphClientSecret}
              />
              {hasExistingGraphSecret && !graphClientSecret && (
                <p className="text-xs text-muted mt-1">
                  A client secret is already configured. Leave blank to keep it unchanged.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Email Template */}
      <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
        <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Email Template
        </h5>
        <p className="text-xs text-muted">
          Optional HTML header and footer injected into outbound email responses.
        </p>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Header HTML</label>
          <textarea
            className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y"
            placeholder='<div style="background:#003366;color:white;padding:12px">Company Name</div>'
            value={emailHeader}
            onChange={(e) => setEmailHeader(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Footer HTML</label>
          <textarea
            className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y"
            placeholder='<div style="font-size:11px;color:#666">Confidential notice</div>'
            value={emailFooter}
            onChange={(e) => setEmailFooter(e.target.value)}
          />
        </div>
        <Checkbox
          checked={csatEnabled}
          onChange={(checked) => setCsatEnabled(checked)}
          label="Include CSAT feedback rating in outbound emails"
          className="pt-1"
        />
      </div>
    </>
  );
}

function AI4WFields({
  callbackBaseUrl,
  setCallbackBaseUrl,
}: {
  callbackBaseUrl: string;
  setCallbackBaseUrl: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <Input
        label="Callback Base URL"
        placeholder="https://your-ai4w-instance.example.com/abl-callbacks"
        value={callbackBaseUrl}
        onChange={(e) => setCallbackBaseUrl(e.target.value)}
      />
      <p className="text-xs text-muted -mt-2">
        The base URL where ABL sends async responses and proactive notifications. Required when AI4W
        uses the async response mode.
      </p>
    </div>
  );
}

function WebhookFields({
  callbackUrl,
  setCallbackUrl,
  events,
  setEvents,
  errors,
}: {
  callbackUrl: string;
  setCallbackUrl: (v: string) => void;
  events: string[];
  setEvents: (v: string[]) => void;
  errors: Record<string, string>;
}) {
  const t = useTranslations('channels.config');

  const toggleEvent = useCallback(
    (eventValue: string, checked: boolean) => {
      if (checked) {
        setEvents([...events, eventValue]);
      } else {
        setEvents(events.filter((e) => e !== eventValue));
      }
    },
    [events, setEvents],
  );

  return (
    <>
      <Input
        label={t('callback_url_label')}
        placeholder={t('callback_url_placeholder')}
        value={callbackUrl}
        onChange={(e) => setCallbackUrl(e.target.value)}
        error={errors.callbackUrl}
      />

      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">
          {t('event_subscriptions_label')}
        </label>
        <div className="space-y-2.5">
          {AVAILABLE_EVENT_IDS.map((eventId) => (
            <Checkbox
              key={eventId}
              checked={events.includes(eventId)}
              onChange={(checked) => toggleEvent(eventId, checked)}
              label={t(EVENT_LABEL_KEYS[eventId])}
              description={eventId}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// =============================================================================
// SDK WIDGET CONFIGURATION
// =============================================================================

const MODE_IDS = ['chat', 'voice', 'unified'] as const;
const MODE_ICONS = { chat: MessageSquare, voice: Mic, unified: Globe } as const;
const POSITION_IDS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
const PIPELINE_IDS = ['pipeline', 'realtime', 'auto'] as const;

function parseWidgetConfig(config: Record<string, unknown> | undefined | null) {
  const c = config || {};
  return {
    mode: (c.mode as string) || 'chat',
    position: (c.position as string) || 'bottom-right',
    chatEnabled: c.chatEnabled !== false,
    voiceEnabled: !!c.voiceEnabled,
    showActivityUpdates: readSdkChannelShowActivityUpdates(c),
    welcomeMessage: (c.welcomeMessage as string) || '',
    placeholderText: (c.placeholderText as string) || '',
    voicePipeline: (c.voicePipeline as string) || 'pipeline',
  };
}

function parseSdkTokenEnvelopePolicy(
  config: Record<string, unknown> | undefined | null,
): SDKTokenEnvelopePolicy {
  const value = config?.sdkTokenEnvelopePolicy;
  return value === 'signed' || value === 'jwe_preferred' || value === 'jwe_required'
    ? value
    : 'inherit';
}

function parseSdkChannelAuth(auth: ChannelInstance['auth']): {
  mode: 'anonymous' | 'hosted_exchange';
  hasServerSecret: boolean;
  serverSecretPrefix?: string;
  serverSecretLastRotatedAt?: string;
} {
  return {
    mode: auth?.mode === 'hosted_exchange' ? 'hosted_exchange' : 'anonymous',
    hasServerSecret: auth?.hasServerSecret === true,
    ...(auth?.serverSecretPrefix ? { serverSecretPrefix: auth.serverSecretPrefix } : {}),
    ...(auth?.serverSecretLastRotatedAt
      ? { serverSecretLastRotatedAt: auth.serverSecretLastRotatedAt }
      : {}),
  };
}

function SDKWidgetFields({
  projectId,
  instance,
  onRefresh,
}: {
  projectId: string;
  instance: ChannelInstance;
  onRefresh: () => void;
}) {
  const t = useTranslations('channels.config');
  const initial = useMemo(() => parseWidgetConfig(instance.config), [instance.config]);
  const initialAuth = useMemo(() => parseSdkChannelAuth(instance.auth), [instance.auth]);
  const initialTokenEnvelopePolicy = useMemo(
    () => parseSdkTokenEnvelopePolicy(instance.config),
    [instance.config],
  );

  const MODE_OPTIONS = MODE_IDS.map((id) => ({
    id,
    label: t(`mode_${id}`),
    icon: MODE_ICONS[id],
  }));

  const POSITION_OPTIONS = POSITION_IDS.map((id) => ({
    id,
    label: t(`position_${id.replace(/-/g, '_')}`),
  }));

  const VOICE_PIPELINE_OPTIONS = PIPELINE_IDS.map((id) => ({
    id,
    label: t(`pipeline_${id}`),
    description: t(`pipeline_${id}_description`),
  }));
  const TOKEN_ENVELOPE_OPTIONS = [
    { value: 'inherit', label: t('sdk_token_envelope_policy_inherit') },
    { value: 'signed', label: t('sdk_token_envelope_policy_signed') },
    { value: 'jwe_preferred', label: t('sdk_token_envelope_policy_jwe_preferred') },
    { value: 'jwe_required', label: t('sdk_token_envelope_policy_jwe_required') },
  ];

  const [mode, setMode] = useState(initial.mode);
  const [position, setPosition] = useState(initial.position);
  const [chatEnabled, setChatEnabled] = useState(initial.chatEnabled);
  const [voiceEnabled, setVoiceEnabled] = useState(initial.voiceEnabled);
  const [showActivityUpdates, setShowActivityUpdates] = useState(initial.showActivityUpdates);
  const [authMode, setAuthMode] = useState(initialAuth.mode);
  const [tokenEnvelopePolicy, setTokenEnvelopePolicy] = useState<SDKTokenEnvelopePolicy>(
    initialTokenEnvelopePolicy,
  );
  const [sdkJweCapability, setSdkJweCapability] = useState<SDKJweCapability | null>(null);
  const [generatedServerSecret, setGeneratedServerSecret] = useState<string | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState(initial.welcomeMessage);
  const [placeholderText, setPlaceholderText] = useState(initial.placeholderText);
  const [voicePipeline, setVoicePipeline] = useState(initial.voicePipeline);
  const [saving, setSaving] = useState(false);
  const [rotatingSecret, setRotatingSecret] = useState(false);

  const isDirty =
    mode !== initial.mode ||
    position !== initial.position ||
    chatEnabled !== initial.chatEnabled ||
    voiceEnabled !== initial.voiceEnabled ||
    showActivityUpdates !== initial.showActivityUpdates ||
    authMode !== initialAuth.mode ||
    tokenEnvelopePolicy !== initialTokenEnvelopePolicy ||
    welcomeMessage !== initial.welcomeMessage ||
    placeholderText !== initial.placeholderText ||
    voicePipeline !== initial.voicePipeline;

  const showVoicePipeline = voiceEnabled || mode === 'voice' || mode === 'unified';
  const showSdkJweRequiredWarning =
    authMode === 'hosted_exchange' &&
    tokenEnvelopePolicy === 'jwe_required' &&
    sdkJweCapability !== null &&
    (!sdkJweCapability.canIssueBootstrap || !sdkJweCapability.canIssueSession);

  useEffect(() => {
    if (authMode !== 'hosted_exchange') {
      setSdkJweCapability(null);
      return;
    }

    let cancelled = false;
    fetchSdkJweCapability(projectId)
      .then((capability) => {
        if (!cancelled) {
          setSdkJweCapability(capability);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSdkJweCapability(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authMode, projectId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updatedConfig: Record<string, unknown> = {
        mode,
        position,
        chatEnabled,
        voiceEnabled,
        showActivityUpdates,
        welcomeMessage: welcomeMessage || null,
        placeholderText: placeholderText || null,
        voicePipeline,
        ...(authMode === 'hosted_exchange' ? { sdkTokenEnvelopePolicy: tokenEnvelopePolicy } : {}),
      };
      const response = await updateChannel(projectId, instance._sourceId, {
        config: updatedConfig,
        ...(authMode !== initialAuth.mode ? { auth: { mode: authMode } } : {}),
      });
      if (response.serverSecret) {
        setGeneratedServerSecret(response.serverSecret);
      }
      toast.success(t('widget_saved'));
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('widget_save_failed')));
    } finally {
      setSaving(false);
    }
  }, [
    mode,
    position,
    chatEnabled,
    voiceEnabled,
    showActivityUpdates,
    authMode,
    initialAuth.mode,
    initialTokenEnvelopePolicy,
    tokenEnvelopePolicy,
    welcomeMessage,
    placeholderText,
    voicePipeline,
    projectId,
    instance._sourceId,
    onRefresh,
  ]);

  const handleRotateServerSecret = useCallback(async () => {
    setRotatingSecret(true);
    try {
      const response = await updateChannel(projectId, instance._sourceId, {
        auth: {
          mode: 'hosted_exchange',
          rotateServerSecret: true,
        },
      });
      if (response.serverSecret) {
        setGeneratedServerSecret(response.serverSecret);
      }
      toast.success(t('sdk_auth_rotate_success'));
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('sdk_auth_rotate_failed')));
    } finally {
      setRotatingSecret(false);
    }
  }, [instance._sourceId, onRefresh, projectId, t]);

  const hostedSecretRotatedAtLabel =
    initialAuth.serverSecretLastRotatedAt &&
    !Number.isNaN(new Date(initialAuth.serverSecretLastRotatedAt).getTime())
      ? new Date(initialAuth.serverSecretLastRotatedAt).toLocaleString()
      : t('sdk_auth_secret_not_rotated');

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-default bg-background-muted p-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-accent-subtle">
            <Globe className="w-4 h-4 text-accent" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{t('sdk_auth_title')}</p>
            <p className="text-xs text-muted mt-1">{t('sdk_auth_description')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
            {t('sdk_auth_mode_label')}
          </span>
          <div className="grid gap-2 md:grid-cols-2 w-full max-w-xl">
            {(
              [
                ['anonymous', t('sdk_auth_mode_value_anonymous')],
                ['hosted_exchange', t('sdk_auth_mode_value_hosted')],
              ] as const
            ).map(([modeId, label]) => (
              <button
                key={modeId}
                type="button"
                onClick={() => setAuthMode(modeId)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-default ${
                  authMode === modeId
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-default bg-background text-foreground hover:border-muted'
                }`}
              >
                <span className="font-medium">{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 mt-3">
          <div className="rounded-lg border border-default bg-background p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">
              {t('sdk_auth_browser_title')}
            </p>
            <p className="text-xs text-muted mt-1">
              {authMode === 'hosted_exchange'
                ? t('sdk_auth_browser_description_hosted')
                : t('sdk_auth_browser_description')}
            </p>
          </div>
          <div className="rounded-lg border border-default bg-background p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">
              {t('sdk_auth_server_title')}
            </p>
            <p className="text-xs text-muted mt-1">
              {authMode === 'hosted_exchange'
                ? t('sdk_auth_server_description_hosted')
                : t('sdk_auth_server_description')}
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-warning/30 bg-warning-subtle p-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-warning">
                {t('sdk_auth_security_title')}
              </p>
              <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-warning">
                <li>
                  {authMode === 'hosted_exchange'
                    ? t('sdk_auth_security_public_hosted')
                    : t('sdk_auth_security_public')}
                </li>
                <li>
                  {authMode === 'hosted_exchange'
                    ? t('sdk_auth_security_identity_hosted')
                    : t('sdk_auth_security_identity')}
                </li>
                <li>{t('sdk_auth_security_origins')}</li>
                <li>{t('sdk_auth_security_activity')}</li>
                {authMode === 'hosted_exchange' && <li>{t('sdk_auth_security_secret_reveal')}</li>}
              </ul>
            </div>
          </div>
        </div>

        {authMode === 'hosted_exchange' && (
          <div className="mt-3 space-y-3">
            <div className="rounded-lg border border-default bg-background p-3">
              <Select
                label={t('sdk_token_envelope_policy_label')}
                options={TOKEN_ENVELOPE_OPTIONS}
                value={tokenEnvelopePolicy}
                onChange={(value) => setTokenEnvelopePolicy(value as SDKTokenEnvelopePolicy)}
              />
              <p className="mt-2 text-xs text-muted">
                {tokenEnvelopePolicy === 'jwe_required'
                  ? t('sdk_token_envelope_policy_required_hint')
                  : t('sdk_token_envelope_policy_hint')}
              </p>
              {showSdkJweRequiredWarning && (
                <p className="mt-2 text-xs text-warning">
                  {t('sdk_token_envelope_policy_unavailable')}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-default bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-2">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                      {t('sdk_auth_secret_status_label')}
                    </p>
                    <p className="text-sm text-foreground">
                      {initialAuth.hasServerSecret
                        ? t('sdk_auth_secret_status_ready')
                        : t('sdk_auth_secret_status_missing')}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                      {t('sdk_auth_secret_prefix_label')}
                    </p>
                    <p className="text-sm text-foreground">
                      {initialAuth.serverSecretPrefix || t('sdk_auth_secret_prefix_missing')}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                      {t('sdk_auth_secret_rotated_label')}
                    </p>
                    <p className="text-sm text-foreground">{hostedSecretRotatedAtLabel}</p>
                  </div>
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRotateServerSecret}
                  loading={rotatingSecret}
                  disabled={authMode !== 'hosted_exchange' || isDirty}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  {t('sdk_auth_rotate_button')}
                </Button>
              </div>
            </div>

            {generatedServerSecret && (
              <div className="rounded-lg border border-warning/30 bg-warning-subtle p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-warning">
                      {t('sdk_auth_generated_secret_title')}
                    </p>
                    <p className="text-xs text-warning mt-1">
                      {t('sdk_auth_generated_secret_description')}
                    </p>
                  </div>
                </div>
                <CodeBlock
                  code={generatedServerSecret}
                  language={t('sdk_auth_generated_secret_code_label')}
                  maxHeight="160px"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mode picker */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('widget_mode_label')}
        </label>
        <div className="grid grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-default text-sm ${
                mode === opt.id
                  ? 'border-accent bg-accent-subtle text-accent'
                  : 'border-default bg-background-subtle text-muted hover:border-muted'
              }`}
            >
              <opt.icon className="w-4 h-4" />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Position picker */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('position_label')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {POSITION_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setPosition(opt.id)}
              className={`px-3 py-2 rounded-lg border text-sm transition-default ${
                position === opt.id
                  ? 'border-accent bg-accent-subtle text-accent'
                  : 'border-default bg-background-subtle text-muted hover:border-muted'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feature toggles */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('features_label')}
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between p-3 bg-background-subtle rounded-lg">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-muted" />
              <span className="text-sm text-foreground">{t('feature_chat')}</span>
            </div>
            <Toggle checked={chatEnabled} onChange={setChatEnabled} />
          </div>
          <div className="flex items-center justify-between p-3 bg-background-subtle rounded-lg">
            <div className="flex items-center gap-2">
              <Mic className="w-4 h-4 text-muted" />
              <span className="text-sm text-foreground">{t('feature_voice')}</span>
            </div>
            <Toggle checked={voiceEnabled} onChange={setVoiceEnabled} />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-default bg-background-muted p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('show_activity_updates')}</p>
            <p className="text-xs text-muted">{t('show_activity_updates_hint')}</p>
          </div>
          <Toggle checked={showActivityUpdates} onChange={setShowActivityUpdates} />
        </div>
      </div>

      {/* Voice Pipeline picker */}
      {showVoicePipeline && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('voice_pipeline_label')}
          </label>
          <div className="grid grid-cols-3 gap-3">
            {VOICE_PIPELINE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setVoicePipeline(opt.id)}
                className={`flex flex-col items-start gap-1 p-3 rounded-lg border transition-default text-sm ${
                  voicePipeline === opt.id
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-default bg-background-subtle text-muted hover:border-muted'
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-xs opacity-70">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="space-y-4">
        <Input
          label={t('welcome_message_label')}
          value={welcomeMessage}
          onChange={(e) => setWelcomeMessage(e.target.value)}
          placeholder={t('welcome_message_placeholder')}
        />
        <Input
          label={t('input_placeholder_label')}
          value={placeholderText}
          onChange={(e) => setPlaceholderText(e.target.value)}
          placeholder={t('input_placeholder_value')}
        />
      </div>

      {/* Save */}
      <div className="flex items-center justify-between">
        {isDirty && <span className="text-xs text-warning">{t('unsaved_changes')}</span>}
        {!isDirty && <span />}
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={saving}
          disabled={!isDirty}
        >
          {t('save_configuration')}
        </Button>
      </div>
    </div>
  );
}

function VoiceFields({
  projectId,
  channelType,
  config,
  setConfig,
}: {
  projectId: string;
  channelType: ChannelTypeId;
  config: Record<string, unknown>;
  setConfig: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}) {
  const t = useTranslations('channels.config');
  const isVxml = channelType === 'voice_vxml';
  const isRealtime = channelType === 'voice_realtime';
  const isPipeline = channelType === 'voice_pipeline';

  const updateField = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const updateS2SProvider = (provider: string) => {
    setConfig((prev) => normalizeS2SProviderConfig(prev, provider));
  };

  useEffect(() => {
    if (!isRealtime || typeof config.s2sProvider !== 'string') {
      return;
    }

    setConfig((prev) => {
      if (typeof prev.s2sProvider !== 'string') {
        return prev;
      }
      const normalized = normalizeActiveS2SProviderConfig(prev, prev.s2sProvider);
      return recordsEqual(prev, normalized) ? prev : normalized;
    });
  }, [
    isRealtime,
    config.s2sProvider,
    config.s2sModel,
    config.s2sVoice,
    config.s2sTemperature,
    config.s2sThreshold,
    config.s2sTurnDetection,
    config.s2sSilenceDuration,
    config.s2sPrefixPadding,
    config.s2sAgentId,
    config.s2sConversationId,
    setConfig,
  ]);

  const set = (key: string, value: unknown) => setConfig((prev) => ({ ...prev, [key]: value }));

  const [searchCountry, setSearchCountry] = useState('US');
  const [searchNumberType, setSearchNumberType] = useState<'local' | 'tollFree'>('local');
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [searchResults, setSearchResults] = useState<AvailablePhoneNumber[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedAvailable, setSelectedAvailable] = useState('');
  const [buying, setBuying] = useState(false);

  // Speech provider state — fetched from admin-configured service instances
  const tenantId = useAuthStore((s) => s.tenantId);
  const [sttProviders, setSttProviders] = useState<SpeechProvider[]>([]);
  const [ttsProviders, setTtsProviders] = useState<SpeechProvider[]>([]);

  // Dynamic speech options from Jambonz
  const [sttOptions, setSttOptions] = useState<SpeechOptions>({ tts: [], stt: [] });
  const [ttsOptions, setTtsOptions] = useState<SpeechOptions>({ tts: [], stt: [] });
  const [sttLoading, setSttLoading] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  // Cache to avoid re-fetching for the same vendor
  const speechOptionsCache = useRef<Record<string, SpeechOptions>>({});

  const loadSpeechOptions = useCallback(async (vendor: string) => {
    if (speechOptionsCache.current[vendor]) {
      return speechOptionsCache.current[vendor];
    }
    const options = await fetchSpeechOptions(vendor);
    speechOptionsCache.current[vendor] = options;
    return options;
  }, []);

  const selectedSttProvider = useMemo(
    () => findPreferredSpeechProvider(sttProviders, config.asrServiceInstanceId, config.asrVendor),
    [config.asrServiceInstanceId, config.asrVendor, sttProviders],
  );

  const selectedTtsProvider = useMemo(
    () => findPreferredSpeechProvider(ttsProviders, config.ttsServiceInstanceId, config.ttsVendor),
    [config.ttsServiceInstanceId, config.ttsVendor, ttsProviders],
  );

  useEffect(() => {
    if (!tenantId) return;
    fetchConfiguredSpeechProviders(tenantId).then(({ stt, tts }) => {
      setSttProviders(stt);
      setTtsProviders(tts);
      setConfig((prev) => {
        const next = { ...prev };
        const sttProvider = findPreferredSpeechProvider(
          stt,
          prev.asrServiceInstanceId,
          prev.asrVendor,
        );
        const ttsProvider = findPreferredSpeechProvider(
          tts,
          prev.ttsServiceInstanceId,
          prev.ttsVendor,
        );

        if (sttProvider) {
          next.asrVendor = sttProvider.serviceType;
          next.asrServiceInstanceId = sttProvider.id;
          if (sttProvider.serviceType !== MICROSOFT_SPEECH_VENDOR) {
            next.asrAlternativeLanguages = [];
          }
        }

        if (ttsProvider) {
          next.ttsVendor = ttsProvider.serviceType;
          next.ttsServiceInstanceId = ttsProvider.id;
          const configuredVoice = getProviderConfigString(ttsProvider, 'voiceId');
          if (configuredVoice && (prev.ttsServiceInstanceId !== ttsProvider.id || !prev.ttsVoice)) {
            next.ttsVoice = configuredVoice;
          }
        }

        return next;
      });
    });
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // SBC address for BYOC SIP provider
  const [sbcAddresses, setSbcAddresses] = useState<string[]>([]);

  useEffect(() => {
    if (config.provider === 'byoc_sip') {
      fetchSbcAddresses(projectId).then(setSbcAddresses);
    }
  }, [config.provider, projectId]);

  // Fetch dynamic STT options when vendor changes
  useEffect(() => {
    const vendor = selectedSttProvider?.serviceType;
    if (!vendor) return;
    setSttLoading(true);
    setSttError(null);
    loadSpeechOptions(vendor)
      .then((opts) => setSttOptions(opts))
      .catch(() => setSttError(t('stt_options_error')))
      .finally(() => setSttLoading(false));
  }, [loadSpeechOptions, selectedSttProvider?.serviceType]);

  // Fetch dynamic TTS options when vendor changes
  useEffect(() => {
    const vendor = selectedTtsProvider?.serviceType;
    if (!vendor) return;
    setTtsLoading(true);
    setTtsError(null);
    loadSpeechOptions(vendor)
      .then((opts) => setTtsOptions(opts))
      .catch(() => setTtsError(t('tts_options_error')))
      .finally(() => setTtsLoading(false));
  }, [loadSpeechOptions, selectedTtsProvider?.serviceType]);

  const handleAsrProviderChange = useCallback(
    (serviceInstanceId: string) => {
      const provider = sttProviders.find((candidate) => candidate.id === serviceInstanceId);
      if (!provider) {
        return;
      }

      setConfig((prev) => ({
        ...prev,
        asrVendor: provider.serviceType,
        asrServiceInstanceId: provider.id,
        ...(provider.serviceType !== MICROSOFT_SPEECH_VENDOR
          ? { asrAlternativeLanguages: [] }
          : {}),
      }));
    },
    [setConfig, sttProviders],
  );

  const handleTtsProviderChange = useCallback(
    (serviceInstanceId: string) => {
      const provider = ttsProviders.find((candidate) => candidate.id === serviceInstanceId);
      if (!provider) {
        return;
      }

      setConfig((prev) => {
        const next: Record<string, unknown> = {
          ...prev,
          ttsVendor: provider.serviceType,
          ttsServiceInstanceId: provider.id,
        };
        const configuredVoice = getProviderConfigString(provider, 'voiceId');
        if (configuredVoice && (prev.ttsServiceInstanceId !== provider.id || !prev.ttsVoice)) {
          next.ttsVoice = configuredVoice;
        }
        return next;
      });
    },
    [setConfig, ttsProviders],
  );

  const handleSearch = useCallback(async () => {
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const results = await searchAvailableNumbers({
        countryCode: searchCountry,
        numberType: searchNumberType,
        areaCode: searchAreaCode || undefined,
      });
      setSearchResults(results);
      setSelectedAvailable('');
    } catch {
      toast.error('Failed to search available numbers');
    } finally {
      setSearchLoading(false);
    }
  }, [searchCountry, searchNumberType, searchAreaCode]);

  const handleBuy = useCallback(async () => {
    if (!selectedAvailable) return;
    setBuying(true);
    try {
      const purchased = await purchasePhoneNumber(selectedAvailable);
      set('phoneNumber', purchased.phoneNumber);
      set('phoneNumberSid', purchased.sid);
      setSearchResults([]);
      setSelectedAvailable('');
      toast.success(`Purchased ${purchased.phoneNumber}`);
    } catch {
      toast.error('Failed to purchase phone number');
    } finally {
      setBuying(false);
    }
  }, [selectedAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAsrLanguage = (config.asrLanguage as string) || sttOptions.stt[0]?.code || '';
  const asrAlternativeLanguages = normalizeStringList(config.asrAlternativeLanguages).filter(
    (language) => language !== selectedAsrLanguage,
  );
  const supportsAlternativeRecognitionLanguages =
    selectedSttProvider?.serviceType === MICROSOFT_SPEECH_VENDOR;
  const alternativeRecognitionLanguageOptions = sttOptions.stt
    .filter((language) => language.code !== selectedAsrLanguage)
    .map((language) => ({ value: language.code, label: language.name }));
  const isMicrosoftTtsProvider = selectedTtsProvider?.serviceType === MICROSOFT_SPEECH_VENDOR;
  const microsoftTtsVoiceOptions = useMemo(() => buildTtsVoiceOptions(ttsOptions), [ttsOptions]);
  const selectedMicrosoftTtsVoice = microsoftTtsVoiceOptions.find(
    (voice) => voice.value === config.ttsVoice,
  );

  useEffect(() => {
    if (!isMicrosoftTtsProvider || !selectedMicrosoftTtsVoice) {
      return;
    }

    setConfig((prev) => {
      if (
        prev.ttsVoice !== selectedMicrosoftTtsVoice.value ||
        prev.ttsLanguage === selectedMicrosoftTtsVoice.languageCode
      ) {
        return prev;
      }

      return {
        ...prev,
        ttsLanguage: selectedMicrosoftTtsVoice.languageCode,
      };
    });
  }, [
    isMicrosoftTtsProvider,
    selectedMicrosoftTtsVoice?.value,
    selectedMicrosoftTtsVoice?.languageCode,
    setConfig,
  ]);

  return (
    <>
      {/* Provider */}
      <Select
        label={t('voice_provider_label')}
        options={VOICE_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        value={(config.provider as string) || 'kore_vgw'}
        onChange={(v) => updateField('provider', v)}
      />

      {/* BYOC SIP Configuration */}
      {config.provider === 'byoc_sip' && !isVxml && (
        <div className="space-y-4">
          <h4 className="text-sm font-medium">SIP Configuration</h4>

          {/* Our SBC Address(es) — read-only, copyable */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Our SIP Server Address{sbcAddresses.length > 1 ? 'es' : ''}
            </label>
            {sbcAddresses.length > 0 ? (
              <div className="space-y-2">
                {sbcAddresses.map((addr) => (
                  <div key={addr} className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={addr}
                      className="flex-1 rounded-md border border-default bg-background-muted px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(addr);
                        toast.success('SBC address copied');
                      }}
                      className="px-3 py-2 text-sm border border-default rounded-md hover:bg-background-muted transition-fast"
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <input
                type="text"
                readOnly
                value="Not configured — contact admin"
                className="w-full rounded-md border border-default bg-background-muted px-3 py-2 text-sm font-mono text-muted"
              />
            )}
            <p className="text-xs text-muted mt-1">
              Configure your SIP provider to send INVITE to{' '}
              {sbcAddresses.length > 1 ? 'one of these addresses' : 'this address'}
            </p>
          </div>

          {/* Customer's SIP Gateway IP */}
          <div>
            <label className="block text-sm font-medium mb-1">SIP Gateway IP Address</label>
            <input
              type="text"
              placeholder="e.g. 203.0.113.50 or 203.0.113.50:5080"
              value={(config.sipGatewayIp as string) || ''}
              onChange={(e) => setConfig((prev) => ({ ...prev, sipGatewayIp: e.target.value }))}
              className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-muted mt-1">
              Your SIP trunk IP address — optionally include port (default: 5060)
            </p>
          </div>

          {/* DID / Phone Number */}
          <div>
            <label className="block text-sm font-medium mb-1">DID / Phone Number</label>
            <input
              type="text"
              placeholder="e.g. +14155551234 or 98492"
              value={(config.phoneNumber as string) || ''}
              onChange={(e) => setConfig((prev) => ({ ...prev, phoneNumber: e.target.value }))}
              className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-muted mt-1">
              The phone number (DID) your SIP provider routes to this SIP gateway.
            </p>
          </div>
        </div>
      )}

      {/* Phone Number (Twilio/Telnyx) - for kore_vgw provider */}
      {config.provider !== 'byoc_sip' && !isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            {t('phone_number_title')}
          </h5>
          <Select
            label={t('provider_label')}
            options={PHONE_NUMBER_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            value={(config.phoneProvider as string) || 'twilio'}
            onChange={(v) => updateField('phoneProvider', v)}
          />
          {/* Assigned number (read-only) */}
          {config.phoneNumber ? (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                {t('phone_number_label')}
              </label>
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-background border border-default">
                <span className="text-sm font-medium text-foreground">
                  {config.phoneNumber as string}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    set('phoneNumber', '');
                    set('phoneNumberSid', '');
                  }}
                  className="text-xs text-muted hover:text-error transition-default"
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            /* Manual entry or search & buy */
            <div className="space-y-3">
              {/* Manual phone number entry */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Phone Number (DID)
                </label>
                <input
                  type="text"
                  placeholder="e.g. +14155551234 or 98492"
                  value={(config.phoneNumber as string) || ''}
                  onChange={(e) => setConfig((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                  className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm font-mono"
                />
                <p className="text-xs text-muted mt-1">
                  Enter your existing phone number (DID) to register it with the voice gateway.
                </p>
              </div>

              {/* Divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-default"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-background-muted px-2 text-muted">Or buy a new number</span>
                </div>
              </div>

              {/* Search & buy section */}
              <div className="grid grid-cols-2 gap-2">
                <Select
                  label="Country"
                  options={COUNTRY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))}
                  value={searchCountry}
                  onChange={setSearchCountry}
                />
                <Select
                  label="Number Type"
                  options={NUMBER_TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
                  value={searchNumberType}
                  onChange={(v) => setSearchNumberType(v as 'local' | 'tollFree')}
                />
              </div>
              <Input
                label="Area Code (optional)"
                placeholder="e.g. 415"
                value={searchAreaCode}
                onChange={(e) => setSearchAreaCode(e.target.value)}
              />
              <Button variant="secondary" size="sm" loading={searchLoading} onClick={handleSearch}>
                Search Available Numbers
              </Button>

              {searchResults.length > 0 && (
                <div className="space-y-2">
                  <div className="max-h-48 overflow-y-auto">
                    <RadioGroup
                      label="Available Numbers"
                      options={searchResults.map((n) => ({
                        value: n.phoneNumber,
                        label: n.phoneNumber,
                        description: n.region || undefined,
                      }))}
                      value={selectedAvailable}
                      onChange={(v) => setSelectedAvailable(v)}
                      name="available-number"
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={buying}
                    disabled={!selectedAvailable}
                    onClick={handleBuy}
                  >
                    Buy Selected Number
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Speech Recognition (STT) - Pipeline Voice only */}
      {isPipeline && sttProviders.length > 0 && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Speech Recognition
          </h5>
          <Select
            label="Provider"
            options={sttProviders.map((p) => ({ value: p.id, label: p.displayName }))}
            value={selectedSttProvider?.id || ''}
            onChange={handleAsrProviderChange}
          />
          {sttLoading && (
            <p className="text-xs text-muted animate-pulse">{t('loading_speech_options')}</p>
          )}
          {sttError && (
            <div className="flex items-center gap-2">
              <p className="text-xs text-error">{sttError}</p>
              <button
                type="button"
                onClick={() => {
                  const vendor = selectedSttProvider?.serviceType;
                  if (vendor) {
                    delete speechOptionsCache.current[vendor];
                    setSttError(null);
                    loadSpeechOptions(vendor)
                      .then(setSttOptions)
                      .catch(() => setSttError(t('speech_options_error')));
                  }
                }}
                className="text-xs text-info hover:underline"
              >
                {t('retry')}
              </button>
            </div>
          )}
          <SearchableSelect
            label="Language"
            options={sttOptions.stt.map((l) => ({ value: l.code, label: l.name }))}
            value={selectedAsrLanguage}
            onChange={(val) =>
              setConfig((prev) => ({
                ...prev,
                asrLanguage: val,
                asrAlternativeLanguages: normalizeStringList(prev.asrAlternativeLanguages).filter(
                  (language) => language !== val,
                ),
              }))
            }
            disabled={sttLoading || sttOptions.stt.length === 0}
          />
          {supportsAlternativeRecognitionLanguages && (
            <SearchableMultiSelect
              label="Alternative recognition languages"
              options={alternativeRecognitionLanguageOptions}
              value={asrAlternativeLanguages}
              onChange={(languages) => set('asrAlternativeLanguages', languages)}
              disabled={sttLoading || alternativeRecognitionLanguageOptions.length === 0}
              placeholder="Select languages"
            />
          )}
        </div>
      )}

      {/* Speech Synthesis (TTS) - Pipeline Voice only */}
      {isPipeline && ttsProviders.length > 0 && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Speech Synthesis
          </h5>
          <Select
            label="Provider"
            options={ttsProviders.map((p) => ({ value: p.id, label: p.displayName }))}
            value={selectedTtsProvider?.id || ''}
            onChange={handleTtsProviderChange}
          />
          {ttsLoading && (
            <p className="text-xs text-muted animate-pulse">{t('loading_speech_options')}</p>
          )}
          {ttsError && (
            <div className="flex items-center gap-2">
              <p className="text-xs text-error">{ttsError}</p>
              <button
                type="button"
                onClick={() => {
                  const vendor = selectedTtsProvider?.serviceType;
                  if (vendor) {
                    delete speechOptionsCache.current[vendor];
                    setTtsError(null);
                    loadSpeechOptions(vendor)
                      .then(setTtsOptions)
                      .catch(() => setTtsError(t('speech_options_error')));
                  }
                }}
                className="text-xs text-info hover:underline"
              >
                {t('retry')}
              </button>
            </div>
          )}
          {isMicrosoftTtsProvider ? (
            <>
              <SearchableSelect
                label="Voice"
                options={microsoftTtsVoiceOptions.map((voice) => ({
                  value: voice.value,
                  label: voice.label,
                }))}
                value={(config.ttsVoice as string) || ''}
                onChange={(val) => {
                  const voice = microsoftTtsVoiceOptions.find((option) => option.value === val);
                  setConfig((prev) => ({
                    ...prev,
                    ttsVoice: val,
                    ...(voice ? { ttsLanguage: voice.languageCode } : {}),
                  }));
                }}
                disabled={ttsLoading || microsoftTtsVoiceOptions.length === 0}
              />
              {selectedMicrosoftTtsVoice && (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    Language
                  </label>
                  <div className="rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground">
                    {selectedMicrosoftTtsVoice.languageName}{' '}
                    <span className="text-muted">({selectedMicrosoftTtsVoice.languageCode})</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <SearchableSelect
                label="Language"
                options={ttsOptions.tts.map((l) => ({ value: l.code, label: l.name }))}
                value={(config.ttsLanguage as string) || ttsOptions.tts[0]?.code || ''}
                onChange={(val) => set('ttsLanguage', val)}
                disabled={ttsLoading || ttsOptions.tts.length === 0}
              />
              <SearchableSelect
                label="Voice"
                options={(
                  ttsOptions.tts.find(
                    (l) => l.code === ((config.ttsLanguage as string) || ttsOptions.tts[0]?.code),
                  )?.voices ?? []
                ).map((v) => ({ value: v.value, label: v.name }))}
                value={(config.ttsVoice as string) || ''}
                onChange={(val) => set('ttsVoice', val)}
                disabled={ttsLoading || ttsOptions.tts.length === 0}
              />
            </>
          )}
          {(config.ttsVendor as string) === ORPHEUS_TTS_VENDOR && (
            <Checkbox
              checked={config.orpheusWsStreamingEnabled === true}
              onChange={(checked) => set('orpheusWsStreamingEnabled', checked)}
              label={t('orpheus_streaming_label')}
              description={t('orpheus_streaming_description')}
            />
          )}
          {(config.ttsVendor as string) === ELEVENLABS_TTS_VENDOR && (
            <div className="space-y-4 rounded-lg border border-default bg-background-subtle p-3">
              <div>
                <h6 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                  ElevenLabs Voice Settings
                </h6>
                <p className="mt-1 text-xs text-muted">
                  Override playback and prosody for this channel connection.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {ELEVENLABS_CHANNEL_TTS_RANGE_SETTINGS.map((setting) => {
                  const value = getConfigNumber(config, setting.key, setting.defaultValue);
                  return (
                    <div key={setting.key} className="space-y-1.5">
                      <label
                        htmlFor={setting.key}
                        className="block text-sm font-medium text-foreground"
                      >
                        {setting.label}: {value}
                      </label>
                      <input
                        id={setting.key}
                        aria-label={setting.label}
                        type="range"
                        min={setting.min}
                        max={setting.max}
                        step={setting.step}
                        value={value}
                        onChange={(event) => set(setting.key, Number(event.target.value))}
                        className="w-full accent-accent"
                      />
                      <div className="flex justify-between text-xs text-subtle">
                        <span>{setting.min}</span>
                        <span>{setting.max}</span>
                      </div>
                      <p className="text-xs text-muted">{setting.helper}</p>
                    </div>
                  );
                })}
              </div>
              <Checkbox
                checked={config.ttsUseSpeakerBoost !== false}
                onChange={(checked) => set('ttsUseSpeakerBoost', checked)}
                label="Speaker boost"
                description="Enhances speaker similarity and clarity. Turning it off may reduce latency for some voices."
              />
            </div>
          )}
          {selectedTtsProvider &&
            ['elevenlabs', 'custom:orpheus'].includes(selectedTtsProvider.serviceType) && (
              <TTSPreview
                provider={selectedTtsProvider.serviceType}
                serviceInstanceId={selectedTtsProvider.id}
                voice={config.ttsVoice as string}
                model={getProviderConfigString(selectedTtsProvider, 'model')}
                language={config.ttsLanguage as string}
                voiceSettings={
                  selectedTtsProvider.serviceType === ELEVENLABS_TTS_VENDOR
                    ? {
                        speed: getConfigNumber(config, 'ttsSpeed', 1),
                        stability: getConfigNumber(config, 'ttsStability', 0.5),
                        similarityBoost: getConfigNumber(config, 'ttsSimilarityBoost', 0.75),
                        style: getConfigNumber(config, 'ttsStyle', 0),
                        useSpeakerBoost: config.ttsUseSpeakerBoost !== false,
                      }
                    : undefined
                }
              />
            )}
        </div>
      )}

      {/* Info banner when no providers configured - Pipeline only */}
      {isPipeline && sttProviders.length === 0 && ttsProviders.length === 0 && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-warning/5 border border-warning/30">
          <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <p className="text-sm text-muted">
            Configure speech providers in{' '}
            <span className="font-medium text-foreground">Admin &rarr; Voice Services</span> to
            enable ASR/TTS settings.
          </p>
        </div>
      )}

      {/* Realtime LLM Voice Settings - S2S Provider Configuration */}
      {isRealtime && (
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-foreground">Realtime LLM Voice Settings</h4>
          <S2SProviderSelector value={config.s2sProvider as string} onChange={updateS2SProvider} />
          {config.s2sProvider ? (
            <S2SConfigFields
              provider={config.s2sProvider as string}
              config={config}
              onChange={updateField}
            />
          ) : null}
        </div>
      )}

      {/* Pipeline-specific fields */}
      {isPipeline && (
        <div className="space-y-3">
          <Checkbox
            checked={Boolean(config.bargeIn)}
            onChange={(checked) => updateField('bargeIn', checked)}
            label={t('bargein_label')}
            description={t('bargein_description')}
          />
          <Input
            label={t('speech_timeout_label')}
            placeholder={t('speech_timeout_placeholder')}
            value={String(config.speechTimeout || '')}
            onChange={(e) => updateField('speechTimeout', Number(e.target.value) || null)}
          />
          <Input
            label={t('welcome_message_label')}
            placeholder={t('welcome_message_placeholder')}
            value={(config.welcomeMessage as string) || ''}
            onChange={(e) => updateField('welcomeMessage', e.target.value)}
          />
        </div>
      )}

      {/* VXML-specific fields */}
      {isVxml && (
        <div className="space-y-3">
          <Input
            label={t('vxml_url_label')}
            placeholder={t('vxml_url_placeholder')}
            value={(config.vxmlDocUrl as string) || ''}
            onChange={(e) => updateField('vxmlDocUrl', e.target.value)}
          />
          <Input
            label={t('fallback_url_label')}
            placeholder={t('fallback_url_placeholder')}
            value={(config.vxmlFallbackUrl as string) || ''}
            onChange={(e) => updateField('vxmlFallbackUrl', e.target.value)}
          />
        </div>
      )}
    </>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ConfigurationTab({
  projectId,
  channelType,
  channelDef,
  instance,
  onRefresh,
}: ChannelTabProps) {
  const t = useTranslations('channels.config');
  const [displayName, setDisplayName] = useState(instance.displayName);
  const [externalId, setExternalId] = useState(instance.externalIdentifier || '');
  const [callbackUrl, setCallbackUrl] = useState((instance.config?.callbackUrl as string) || '');
  const [events, setEvents] = useState<string[]>(
    (instance.config?.events as string[]) || ['agent.response'],
  );
  const [providerVerificationStrength, setProviderVerificationStrength] = useState<
    'weak' | 'strong'
  >(instance.identityVerification?.providerVerificationStrength || 'weak');
  const [voiceConfig, setVoiceConfig] = useState<Record<string, unknown>>(instance.config || {});
  const [streamingEnabled, setStreamingEnabled] = useState(
    Boolean((instance.config?.streaming as Record<string, unknown> | undefined)?.enabled),
  );
  const [streamingChunkSize, setStreamingChunkSize] = useState(
    String((instance.config?.streaming as Record<string, unknown> | undefined)?.chunkSize || ''),
  );
  const [emailHeader, setEmailHeader] = useState<string>(
    (instance.config?.emailHeader as string) || '',
  );
  const [emailFooter, setEmailFooter] = useState<string>(
    (instance.config?.emailFooter as string) || '',
  );
  const [csatEnabled, setCsatEnabled] = useState<boolean>(!!instance.config?.csatEnabled);
  const outboundConfig = instance.config?.outbound as
    | { transport?: string; graph?: Record<string, string> }
    | undefined;
  const [emailTransport, setEmailTransport] = useState<string>(outboundConfig?.transport || 'smtp');
  const [graphTenantId, setGraphTenantId] = useState<string>(outboundConfig?.graph?.tenantId || '');
  const [graphClientId, setGraphClientId] = useState<string>(outboundConfig?.graph?.clientId || '');
  const [graphSenderAddress, setGraphSenderAddress] = useState<string>(
    outboundConfig?.graph?.senderAddress || '',
  );
  const [graphClientSecret, setGraphClientSecret] = useState<string>('');
  // AI4W-specific config
  const [ai4wCallbackBaseUrl, setAi4wCallbackBaseUrl] = useState<string>(
    (instance.config?.callbackBaseUrl as string) || '',
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const validate = useCallback((): boolean => {
    const next: Record<string, string> = {};

    if (!displayName.trim()) {
      next.displayName = t('display_name_required');
    }

    if (channelDef.category === 'webhook') {
      if (!callbackUrl.trim()) {
        next.callbackUrl = t('callback_url_required');
      } else {
        try {
          new URL(callbackUrl);
        } catch {
          next.callbackUrl = t('valid_url_required');
        }
      }
    }

    if (channelType === 'email' && emailTransport === 'graph') {
      if (!graphTenantId.trim()) next.graphTenantId = 'Tenant ID is required.';
      if (!graphClientId.trim()) next.graphClientId = 'Client ID is required.';
      if (!graphSenderAddress.trim()) next.graphSenderAddress = 'Sender address is required.';
      if (!graphClientSecret && !instance.hasCredentials) {
        next.graphClientSecret = 'Client secret is required.';
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [
    displayName,
    callbackUrl,
    channelDef.category,
    channelType,
    emailTransport,
    graphTenantId,
    graphClientId,
    graphSenderAddress,
    graphClientSecret,
    instance.hasCredentials,
  ]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      switch (instance._source) {
        case 'sdk_channel':
          await updateChannel(projectId, instance._sourceId, {
            name: displayName,
          });
          break;

        case 'channel_connection': {
          const payload: Record<string, unknown> = {
            display_name: displayName,
            identityVerification: {
              providerVerificationStrength,
            },
          };
          if (channelDef.category === 'voice') {
            payload.config = voiceConfig;
          }
          if (channelType === 'slack' || channelType === 'telegram') {
            const chunkVal = parseInt(streamingChunkSize, 10);
            payload.config = {
              ...(instance.config || {}),
              streaming: {
                enabled: streamingEnabled,
                ...(streamingEnabled && chunkVal > 0 ? { chunkSize: chunkVal } : {}),
              },
            };
          }
          if (channelType === 'ai4w') {
            payload.config = {
              ...(instance.config || {}),
              callbackBaseUrl: ai4wCallbackBaseUrl || null,
            };
          }
          if (channelType === 'email') {
            const emailConfig: Record<string, unknown> = {
              ...(instance.config || {}),
              emailHeader: emailHeader || null,
              emailFooter: emailFooter || null,
              csatEnabled,
            };
            if (emailTransport === 'graph') {
              emailConfig.outbound = {
                transport: 'graph',
                graph: {
                  tenantId: graphTenantId,
                  clientId: graphClientId,
                  senderAddress: graphSenderAddress,
                },
              };
              if (graphClientSecret) {
                payload.credentials = { graph_client_secret: graphClientSecret };
              }
            } else {
              emailConfig.outbound = { transport: 'smtp' };
            }
            payload.config = emailConfig;
          }
          const result = await updateConnection(projectId, instance._sourceId, payload);
          // Show warnings from voice gateway sync (e.g. duplicate phone number)
          const resultWarnings = (result as Record<string, unknown>).warnings as
            | string[]
            | undefined;
          if (resultWarnings?.length) {
            resultWarnings.forEach((w) => toast.warning(w));
          }
          break;
        }

        case 'webhook_subscription':
          await updateSubscription(instance._sourceId, {
            callback_url: callbackUrl,
            events,
          });
          break;
      }

      toast.success(t('config_saved'));
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('config_save_failed')));
    } finally {
      setSaving(false);
    }
  }, [
    validate,
    instance._source,
    instance._sourceId,
    instance.config,
    projectId,
    displayName,
    providerVerificationStrength,
    channelType,
    callbackUrl,
    events,
    voiceConfig,
    streamingEnabled,
    streamingChunkSize,
    emailHeader,
    emailFooter,
    csatEnabled,
    emailTransport,
    graphTenantId,
    graphClientId,
    graphSenderAddress,
    graphClientSecret,
    ai4wCallbackBaseUrl,
    channelDef.category,
    onRefresh,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {/* A. Common fields */}
      <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-4">
        <h4 className="text-sm font-semibold text-foreground">{t('general_title')}</h4>

        <Input
          label={t('display_name_label')}
          placeholder={t('display_name_placeholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
        />

        {instance._source === 'channel_connection' && (
          <div className="space-y-1.5">
            <Select
              label={t('verification_strength_label')}
              options={[
                { value: 'weak', label: t('verification_strength_weak') },
                { value: 'strong', label: t('verification_strength_strong') },
              ]}
              value={providerVerificationStrength}
              onChange={(value) => setProviderVerificationStrength(value as 'weak' | 'strong')}
            />
            <p className="text-xs text-muted">{t('verification_strength_help')}</p>
          </div>
        )}
      </div>

      {/* B. Channel-specific fields */}
      <div className="bg-background-elevated border border-default rounded-lg p-4 space-y-4">
        <h4 className="text-sm font-semibold text-foreground">
          {t('settings_title', { name: channelDef.name })}
        </h4>

        {channelDef.category === 'messaging' && (
          <>
            <MessagingFields
              channelDef={channelDef}
              instance={instance}
              externalId={externalId}
              setExternalId={setExternalId}
              errors={errors}
              cannotChangeLabel={t('cannot_change_after_creation')}
            />
            {(channelType === 'slack' || channelType === 'telegram') &&
              instance._source === 'channel_connection' && (
                <SlackStreamingFields
                  streamingEnabled={streamingEnabled}
                  setStreamingEnabled={setStreamingEnabled}
                  chunkSize={streamingChunkSize}
                  setChunkSize={setStreamingChunkSize}
                />
              )}
            {channelType === 'ai4w' && (
              <AI4WFields
                callbackBaseUrl={ai4wCallbackBaseUrl}
                setCallbackBaseUrl={setAi4wCallbackBaseUrl}
              />
            )}
            {channelType === 'email' && (
              <EmailTemplateFields
                emailHeader={emailHeader}
                setEmailHeader={setEmailHeader}
                emailFooter={emailFooter}
                setEmailFooter={setEmailFooter}
                csatEnabled={csatEnabled}
                setCsatEnabled={setCsatEnabled}
                emailTransport={emailTransport}
                setEmailTransport={setEmailTransport}
                graphTenantId={graphTenantId}
                setGraphTenantId={setGraphTenantId}
                graphClientId={graphClientId}
                setGraphClientId={setGraphClientId}
                graphSenderAddress={graphSenderAddress}
                setGraphSenderAddress={setGraphSenderAddress}
                graphClientSecret={graphClientSecret}
                setGraphClientSecret={setGraphClientSecret}
                hasExistingGraphSecret={instance.hasCredentials}
                errors={errors}
              />
            )}
          </>
        )}

        {channelDef.category === 'webhook' && (
          <WebhookFields
            callbackUrl={callbackUrl}
            setCallbackUrl={setCallbackUrl}
            events={events}
            setEvents={setEvents}
            errors={errors}
          />
        )}

        {channelDef.capabilities.supportsWidgetConfiguration && (
          <SDKWidgetFields projectId={projectId} instance={instance} onRefresh={onRefresh} />
        )}

        {channelDef.category === 'voice' && (
          <VoiceFields
            projectId={projectId}
            channelType={channelType}
            config={voiceConfig}
            setConfig={setVoiceConfig}
          />
        )}

        {channelDef.category === 'protocol' && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-background-muted border border-default">
            <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />
            <p className="text-sm text-muted">{t('protocol_info')}</p>
          </div>
        )}
      </div>

      {/* C. Save */}
      <div className="flex justify-end">
        <Button variant="primary" size="md" loading={saving} onClick={handleSave}>
          {t('save_changes')}
        </Button>
      </div>
    </div>
  );
}
