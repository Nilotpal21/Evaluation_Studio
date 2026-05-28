/**
 * Channel Provider Awareness Tests
 *
 * Tests that Studio components correctly resolve provider-specific configuration
 * for channels with multiple BSP providers (e.g. WhatsApp: Meta vs Infobip).
 *
 * Covers:
 *   - getActiveProviderOption helper (pure unit tests)
 *   - CredentialsTab: renders correct fields per provider and auth type
 *   - OverviewTab: shows correct identifier label and webhook URL per provider
 *   - CreateInstanceDialog: provider selector, dynamic fields, identifier labels
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import {
  getChannelDef,
  getActiveProviderOption,
} from '../../components/deployments/channels/channel-registry';
import type { ChannelInstance } from '../../components/deployments/channels/types';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('../../api/channel-connections', () => ({
  createConnection: vi.fn().mockResolvedValue({ connection: {} }),
  updateConnection: vi.fn().mockResolvedValue({ connection: {} }),
}));

vi.mock('../../api/channels', () => ({
  createChannel: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../api/http-async-channels', () => ({
  createSubscription: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../api/channel-oauth', () => ({
  initiateChannelOAuth: vi.fn(),
  exchangeChannelOAuthCode: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ keys: [] }),
    ok: true,
  }),
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../contexts/RuntimeConfigContext', () => ({
  useRuntimeConfig: () => ({ runtimeUrl: 'http://localhost:3112' }),
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: any) => any) => {
      const state = {
        accessToken: 'tok',
        isAuthenticated: true,
        tenantId: 'tenant-1',
        user: { id: 'u1' },
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ accessToken: 'tok', tenantId: 'tenant-1' }) },
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ open, children, title }: any) =>
    open ? (
      <div data-testid="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

vi.mock('../../components/ui/Input', () => ({
  Input: ({ label, placeholder, error, ...props }: any) => (
    <div>
      <label>{label}</label>
      <input aria-label={label} placeholder={placeholder} {...props} />
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, options, value, onChange, ...props }: any) => (
    <div>
      <label>{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(e: any) => onChange?.(e.target.value)}
        {...props}
      >
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: ({ checked, onChange, label, description }: any) => (
    <div>
      <label>
        <input
          aria-label={label}
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          type="checkbox"
        />
        {label}
      </label>
      {description ? <span>{description}</span> : null}
    </div>
  ),
}));

vi.mock('../../components/ui/RadioGroup', () => ({
  RadioGroup: ({ label, options, value, onChange, name }: any) => (
    <fieldset>
      <legend>{label}</legend>
      {options?.map((option: any) => (
        <label key={option.value}>
          <input
            checked={value === option.value}
            name={name}
            onChange={() => onChange?.(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  ),
}));

vi.mock('../../components/ui/SearchableSelect', () => ({
  SearchableSelect: ({ label, options, value, onChange }: any) => (
    <div>
      <label>{label}</label>
      <select aria-label={label} value={value} onChange={(e) => onChange?.(e.target.value)}>
        {options?.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('../../components/ui/Toggle', () => ({
  Toggle: ({ checked, onChange }: any) => (
    <input
      aria-label="toggle"
      checked={checked}
      onChange={(e) => onChange?.(e.target.checked)}
      type="checkbox"
    />
  ),
}));

vi.mock('../../components/ui/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

vi.mock('../../api/voice', () => ({
  searchAvailableNumbers: vi.fn().mockResolvedValue([]),
  purchasePhoneNumber: vi.fn(),
  fetchSbcAddresses: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/speech-providers', () => ({
  fetchConfiguredSpeechProviders: vi.fn().mockResolvedValue({ stt: [], tts: [] }),
  fetchSpeechOptions: vi.fn().mockResolvedValue({ stt: [], tts: [] }),
}));

vi.mock('../../components/deployments/channels/S2SProviderSelector', () => ({
  S2SProviderSelector: () => null,
}));

vi.mock('../../components/deployments/channels/S2SConfigFields', () => ({
  S2SConfigFields: () => null,
}));

// =============================================================================
// TEST FIXTURES
// =============================================================================

const whatsappDef = getChannelDef('whatsapp');
const slackDef = getChannelDef('slack');
const voicePipelineDef = getChannelDef('voice_pipeline');
const sdkWebDef = getChannelDef('sdk_web');
const sdkApiDef = getChannelDef('sdk_api');

function makeInstance(overrides: Partial<ChannelInstance> = {}): ChannelInstance {
  return {
    id: 'conn_1',
    channelType: 'whatsapp',
    displayName: 'Test WA',
    status: 'active',
    environment: null,
    externalIdentifier: '+1234567890',
    hasCredentials: true,
    config: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    _source: 'channel_connection',
    _sourceId: 'src-1',
    ...overrides,
  };
}

const META_INSTANCE = makeInstance({ config: { provider: 'meta_cloud' } });
const INFOBIP_APIKEY_INSTANCE = makeInstance({
  config: { provider: 'infobip', authType: 'api_key' },
  externalIdentifier: '+447415774332',
});
const INFOBIP_BASIC_INSTANCE = makeInstance({
  config: { provider: 'infobip', authType: 'basic' },
  externalIdentifier: '+447415774332',
});
const NO_PROVIDER_INSTANCE = makeInstance({ config: {} });
const SLACK_INSTANCE = makeInstance({
  channelType: 'slack',
  config: {},
  externalIdentifier: 'T123:A456',
});
const SDK_API_INSTANCE = makeInstance({
  channelType: 'sdk_api',
  displayName: 'Orders API',
  externalIdentifier: null,
  hasCredentials: false,
  environment: 'production',
  deploymentId: 'dep-1',
  config: {},
  _source: 'sdk_channel',
  _sourceId: 'sdk-api-1',
});

// =============================================================================
// 1. getActiveProviderOption — pure unit tests
// =============================================================================

describe('getActiveProviderOption', () => {
  test('returns null for channel without providerOptions (slack)', () => {
    expect(getActiveProviderOption(slackDef, SLACK_INSTANCE)).toBeNull();
  });

  test('returns null when instance config.provider is missing', () => {
    expect(getActiveProviderOption(whatsappDef, NO_PROVIDER_INSTANCE)).toBeNull();
  });

  test('returns Meta option when config.provider is meta_cloud', () => {
    const option = getActiveProviderOption(whatsappDef, META_INSTANCE);
    expect(option).not.toBeNull();
    expect(option!.id).toBe('meta_cloud');
    expect(option!.name).toBe('Meta Cloud API');
    expect(option!.externalIdentifierLabel).toBe('Phone Number ID');
  });

  test('returns Infobip option when config.provider is infobip', () => {
    const option = getActiveProviderOption(whatsappDef, INFOBIP_APIKEY_INSTANCE);
    expect(option).not.toBeNull();
    expect(option!.id).toBe('infobip');
    expect(option!.name).toBe('Infobip');
    expect(option!.externalIdentifierLabel).toBe('WhatsApp Phone Number');
  });

  test('Infobip option does not include auth_type in credential fields', () => {
    const option = getActiveProviderOption(whatsappDef, INFOBIP_APIKEY_INSTANCE);
    const keys = option!.credentialFields.map((f) => f.key);
    expect(keys).not.toContain('auth_type');
    expect(keys).toContain('base_url');
    expect(keys).toContain('api_key');
  });
});

// =============================================================================
// 2. CredentialsTab — provider-aware credential fields
// =============================================================================

describe('CredentialsTab provider awareness', () => {
  let CredentialsTab: any;

  beforeEach(async () => {
    CredentialsTab = (await import('../../components/deployments/channels/tabs/CredentialsTab'))
      .CredentialsTab;
  });

  test('Meta instance renders Meta credential fields', () => {
    render(
      <CredentialsTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={META_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Access Token')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone Number ID')).toBeInTheDocument();
    expect(screen.getByLabelText('App Secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Verify Token')).toBeInTheDocument();
    // Should NOT show Infobip fields
    expect(screen.queryByLabelText('API Base URL')).not.toBeInTheDocument();
  });

  test('Infobip api_key instance renders API Base URL + API Key, not username/password', () => {
    render(
      <CredentialsTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={INFOBIP_APIKEY_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('API Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    // api_key auth hides username/password
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    // Should NOT show Meta fields
    expect(screen.queryByLabelText('Access Token')).not.toBeInTheDocument();
  });

  test('Infobip basic instance renders API Base URL + Username + Password, not API Key', () => {
    render(
      <CredentialsTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={INFOBIP_BASIC_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('API Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    // basic auth hides API Key
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  });
});

// =============================================================================
// 3. OverviewTab — provider-aware identifier label and webhook URL
// =============================================================================

describe('OverviewTab provider awareness', () => {
  let OverviewTab: any;

  beforeEach(async () => {
    OverviewTab = (await import('../../components/deployments/channels/tabs/OverviewTab'))
      .OverviewTab;
  });

  test('Meta instance shows "Phone Number ID" identifier label', () => {
    render(
      <OverviewTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={META_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    // "Phone Number ID" appears as the identifier label in the CopyableField
    const matches = screen.getAllByText('Phone Number ID');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('Infobip instance shows "WhatsApp Phone Number" identifier label', () => {
    render(
      <OverviewTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={INFOBIP_APIKEY_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('WhatsApp Phone Number')).toBeInTheDocument();
  });

  test('uses instance.webhookUrl when provided (Infobip)', () => {
    const instanceWithWebhook = makeInstance({
      config: { provider: 'infobip' },
      webhookUrl: 'http://localhost:3112/api/v1/channels/whatsapp/infobip/webhook',
    });

    render(
      <OverviewTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={instanceWithWebhook}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByText('http://localhost:3112/api/v1/channels/whatsapp/infobip/webhook'),
    ).toBeInTheDocument();
  });

  test('falls back to channelDef.webhookPath when instance.webhookUrl is null', () => {
    const instanceNoWebhookUrl = makeInstance({
      config: { provider: 'meta_cloud' },
      webhookUrl: null,
    });

    render(
      <OverviewTab
        projectId="p1"
        channelType="whatsapp"
        channelDef={whatsappDef}
        instance={instanceNoWebhookUrl}
        onRefresh={vi.fn()}
      />,
    );

    // Should use runtimeUrl + channelDef.webhookPath (no identifier appended)
    expect(
      screen.getByText('http://localhost:3112/api/v1/channels/whatsapp/webhook'),
    ).toBeInTheDocument();
  });

  test('SDK API overview shows the two-step bootstrap and chat flow', () => {
    render(
      <OverviewTab
        projectId="project-123"
        channelType="sdk_api"
        channelDef={sdkApiDef}
        instance={SDK_API_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getAllByText('http://localhost:3112/api/v1/sdk/init').length).toBeGreaterThan(0);
    expect(screen.getAllByText('http://localhost:3112/api/v1/chat/agent').length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/X-Public-Key: pk_your_public_key/)).toBeInTheDocument();
    expect(screen.getByText(/X-SDK-Token: <token from \/api\/v1\/sdk\/init>/)).toBeInTheDocument();
    expect(screen.getByText(/"projectId": "project-123"/)).toBeInTheDocument();
  });
});

// =============================================================================
// 4. CreateInstanceDialog — provider selector and dynamic fields
// =============================================================================

describe('CreateInstanceDialog provider awareness', () => {
  let CreateInstanceDialog: any;

  beforeEach(async () => {
    CreateInstanceDialog = (
      await import('../../components/deployments/channels/CreateInstanceDialog')
    ).CreateInstanceDialog;
  });

  test('WhatsApp channel shows provider selector', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="whatsapp"
        onCreated={vi.fn()}
      />,
    );

    const providerSelect = screen.getByLabelText('Provider');
    expect(providerSelect).toBeInTheDocument();
    expect(screen.getByText('Meta Cloud API')).toBeInTheDocument();
    expect(screen.getByText('Infobip')).toBeInTheDocument();
  });

  test('Slack channel does NOT show provider selector', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="slack"
        onCreated={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });

  test('selecting Infobip shows auth type selector', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="whatsapp"
        onCreated={vi.fn()}
      />,
    );

    // Switch to Infobip
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'infobip' } });

    expect(screen.getByLabelText('Authentication Method')).toBeInTheDocument();
  });

  test('Infobip provider shows "WhatsApp Phone Number" identifier label', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="whatsapp"
        onCreated={vi.fn()}
      />,
    );

    // Default is Meta — "Phone Number ID" appears as both identifier field
    // and Meta credential field, so use getAllByLabelText
    const metaMatches = screen.getAllByLabelText('Phone Number ID');
    expect(metaMatches.length).toBeGreaterThanOrEqual(1);

    // Switch to Infobip
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'infobip' } });

    // Should now show "WhatsApp Phone Number" for the identifier field
    expect(screen.getByLabelText('WhatsApp Phone Number')).toBeInTheDocument();
  });

  test('Infobip provider shows Infobip credential fields, not Meta fields', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="whatsapp"
        onCreated={vi.fn()}
      />,
    );

    // Switch to Infobip
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'infobip' } });

    // Should show Infobip fields
    expect(screen.getByLabelText('API Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    // Should NOT show Meta fields
    expect(screen.queryByLabelText('Access Token')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('App Secret')).not.toBeInTheDocument();
  });

  test('submits provider verification strength for project-scoped channel connections', async () => {
    const { createConnection } = await import('../../api/channel-connections');

    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="slack"
        onCreated={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Display Name'), {
      target: { value: 'Support Slack Bot' },
    });
    fireEvent.change(screen.getByLabelText('Slack Team ID:App ID'), {
      target: { value: 'T01ABCDEF:A01BCDEFG' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials manually instead' }));

    fireEvent.change(screen.getByLabelText('Bot Token'), {
      target: { value: 'xoxb-test-token' },
    });
    fireEvent.change(screen.getByLabelText('Signing Secret'), {
      target: { value: 'secret-value' },
    });
    fireEvent.change(screen.getByLabelText('Provider Verification Strength'), {
      target: { value: 'strong' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createConnection).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          identityVerification: {
            providerVerificationStrength: 'strong',
          },
        }),
      ),
    );
  });

  test('SDK web channel explains anonymous public-key bootstrap', () => {
    render(
      <CreateInstanceDialog
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        channelType="sdk_web"
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByText('Anonymous / Public-key bootstrap')).toBeInTheDocument();
    expect(screen.getByText('Browser / client app')).toBeInTheDocument();
    expect(screen.getByText('Customer backend')).toBeInTheDocument();
    expect(screen.getByText(/No ABL secret is required for anonymous mode/i)).toBeInTheDocument();
    expect(screen.getByText('Security disclaimers')).toBeInTheDocument();
  });
});

// =============================================================================
// 5. ConfigurationTab — identity verification controls
// =============================================================================

describe('ConfigurationTab identity verification controls', () => {
  let ConfigurationTab: any;

  beforeEach(async () => {
    ConfigurationTab = (await import('../../components/deployments/channels/tabs/ConfigurationTab'))
      .ConfigurationTab;
  });

  test('SDK widget guidance is controlled by channel capabilities', () => {
    expect(sdkWebDef.capabilities.supportsWidgetConfiguration).toBe(true);
    expect(sdkApiDef.capabilities.supportsWidgetConfiguration).toBe(false);
  });

  test('updates provider verification strength for channel connections', async () => {
    const { updateConnection } = await import('../../api/channel-connections');
    const slackInstance = makeInstance({
      channelType: 'slack',
      displayName: 'Support Slack Bot',
      config: {},
      identityVerification: {
        providerVerificationStrength: 'weak',
      },
    });

    render(
      <ConfigurationTab
        projectId="p1"
        channelType="slack"
        channelDef={slackDef}
        instance={slackInstance}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Provider Verification Strength'), {
      target: { value: 'strong' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateConnection).toHaveBeenCalledWith(
        'p1',
        'src-1',
        expect.objectContaining({
          display_name: 'Support Slack Bot',
          identityVerification: {
            providerVerificationStrength: 'strong',
          },
        }),
      ),
    );
  });

  test('saves Orpheus streaming toggle for voice pipeline channel connections', async () => {
    const { updateConnection } = await import('../../api/channel-connections');
    const { fetchConfiguredSpeechProviders, fetchSpeechOptions } =
      await import('../../api/speech-providers');

    vi.mocked(fetchConfiguredSpeechProviders).mockResolvedValue({
      stt: [
        {
          id: 'svc-deepgram-1',
          serviceType: 'deepgram',
          displayName: 'Deepgram',
          isDefault: true,
          isActive: true,
        },
      ],
      tts: [
        {
          id: 'svc-orpheus-1',
          serviceType: 'custom:orpheus',
          displayName: 'Orpheus via Groq (TTS)',
          isDefault: true,
          isActive: true,
          config: { voiceId: 'austin' },
        },
      ],
    });
    vi.mocked(fetchSpeechOptions).mockResolvedValue({
      stt: [{ code: 'en-US', name: 'English (US)' }],
      tts: [{ code: 'en', name: 'English', voices: [{ value: 'austin', name: 'Austin' }] }],
    });

    const voiceInstance = makeInstance({
      channelType: 'voice_pipeline',
      displayName: 'Orpheus Test Line',
      config: {
        provider: 'kore_vgw',
        asrVendor: 'deepgram',
        asrServiceInstanceId: 'svc-deepgram-1',
        asrLanguage: 'en-US',
        ttsVendor: 'custom:orpheus',
        ttsServiceInstanceId: 'svc-orpheus-1',
        ttsLanguage: 'en',
        ttsVoice: 'austin',
        orpheusWsStreamingEnabled: false,
      },
      identityVerification: {
        providerVerificationStrength: 'weak',
      },
    });

    render(
      <ConfigurationTab
        projectId="p1"
        channelType="voice_pipeline"
        channelDef={voicePipelineDef}
        instance={voiceInstance}
        onRefresh={vi.fn()}
      />,
    );

    await screen.findByLabelText('Use streaming playback');
    fireEvent.click(screen.getByLabelText('Use streaming playback'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateConnection).toHaveBeenCalledWith(
        'p1',
        'src-1',
        expect.objectContaining({
          display_name: 'Orpheus Test Line',
          config: expect.objectContaining({
            ttsVendor: 'custom:orpheus',
            ttsServiceInstanceId: 'svc-orpheus-1',
            orpheusWsStreamingEnabled: true,
          }),
        }),
      ),
    );
  });

  test('saves ElevenLabs playback settings for voice pipeline channel connections', async () => {
    const { updateConnection } = await import('../../api/channel-connections');
    const { fetchConfiguredSpeechProviders, fetchSpeechOptions } =
      await import('../../api/speech-providers');

    vi.mocked(fetchConfiguredSpeechProviders).mockResolvedValue({
      stt: [
        {
          id: 'svc-deepgram-1',
          serviceType: 'deepgram',
          displayName: 'Deepgram',
          isDefault: true,
          isActive: true,
        },
      ],
      tts: [
        {
          id: 'svc-elevenlabs-1',
          serviceType: 'elevenlabs',
          displayName: 'ElevenLabs (TTS)',
          isDefault: true,
          isActive: true,
          config: { voiceId: 'voice-1', model: 'eleven_multilingual_v2' },
        },
      ],
    });
    vi.mocked(fetchSpeechOptions).mockResolvedValue({
      stt: [{ code: 'en-US', name: 'English (US)' }],
      tts: [{ code: 'en', name: 'English', voices: [{ value: 'voice-1', name: 'Sarah' }] }],
    });

    const voiceInstance = makeInstance({
      channelType: 'voice_pipeline',
      displayName: 'ElevenLabs Test Line',
      config: {
        provider: 'kore_vgw',
        asrVendor: 'deepgram',
        asrServiceInstanceId: 'svc-deepgram-1',
        asrLanguage: 'en-US',
        ttsVendor: 'elevenlabs',
        ttsServiceInstanceId: 'svc-elevenlabs-1',
        ttsLanguage: 'en',
        ttsVoice: 'voice-1',
      },
    });

    render(
      <ConfigurationTab
        projectId="p1"
        channelType="voice_pipeline"
        channelDef={voicePipelineDef}
        instance={voiceInstance}
        onRefresh={vi.fn()}
      />,
    );

    await screen.findByText('ElevenLabs Voice Settings');
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1.1' } });
    fireEvent.change(screen.getByLabelText('Stability'), { target: { value: '0.8' } });
    fireEvent.change(screen.getByLabelText('Similarity boost'), { target: { value: '0.9' } });
    fireEvent.change(screen.getByLabelText('Style exaggeration'), { target: { value: '0.2' } });
    fireEvent.click(screen.getByLabelText('Speaker boost'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateConnection).toHaveBeenCalledWith(
        'p1',
        'src-1',
        expect.objectContaining({
          display_name: 'ElevenLabs Test Line',
          config: expect.objectContaining({
            ttsVendor: 'elevenlabs',
            ttsServiceInstanceId: 'svc-elevenlabs-1',
            ttsSpeed: 1.1,
            ttsStability: 0.8,
            ttsSimilarityBoost: 0.9,
            ttsStyle: 0.2,
            ttsUseSpeakerBoost: false,
          }),
        }),
      ),
    );
  });

  test('SDK web channel shows read-only anonymous auth guidance', () => {
    const sdkWebInstance = makeInstance({
      channelType: 'sdk_web',
      displayName: 'Customer Web Widget',
      externalIdentifier: null,
      hasCredentials: false,
      config: {
        mode: 'chat',
        position: 'bottom-right',
        chatEnabled: true,
        voiceEnabled: false,
        showActivityUpdates: false,
      },
      _source: 'sdk_channel',
    });

    render(
      <ConfigurationTab
        projectId="p1"
        channelType="sdk_web"
        channelDef={sdkWebDef}
        instance={sdkWebInstance}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Anonymous / Public-key bootstrap').length).toBeGreaterThan(0);
    expect(screen.getByText('Auth mode')).toBeInTheDocument();
    expect(screen.getByText(/publishable\. It is not a server secret/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Keep activity updates off for customer-facing channels/i),
    ).toBeInTheDocument();
  });

  test('SDK API channel suppresses widget-only auth guidance', () => {
    render(
      <ConfigurationTab
        projectId="p1"
        channelType="sdk_api"
        channelDef={sdkApiDef}
        instance={SDK_API_INSTANCE}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByText('Auth mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Anonymous / Public-key bootstrap')).not.toBeInTheDocument();
    expect(screen.queryByText(/publishable\. It is not a server secret/i)).not.toBeInTheDocument();
  });
});
