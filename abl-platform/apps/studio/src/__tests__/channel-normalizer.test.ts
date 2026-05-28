import { describe, it, expect } from 'vitest';
import type { SDKChannel } from '../api/channels';
import type { ChannelConnectionSummary } from '../api/channel-connections';
import type { WebhookSubscription } from '../api/http-async-channels';

// Dynamic import to avoid JSX resolution from channel-registry (React elements)
async function loadNormalizer() {
  return import('../components/deployments/channels/channel-normalizer');
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSDKChannel(overrides: Partial<SDKChannel> = {}): SDKChannel {
  return {
    id: 'ch_001',
    tenantId: 'tenant_abc',
    projectId: 'proj_001',
    deploymentId: 'dep_001',
    name: 'Production Widget',
    channelType: 'web',
    publicApiKeyId: 'key_001',
    config: { theme: 'dark' },
    isActive: true,
    environment: 'production',
    followEnvironment: false,
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-20T14:30:00Z',
    ...overrides,
  };
}

function makeConnection(
  overrides: Partial<ChannelConnectionSummary> = {},
): ChannelConnectionSummary {
  return {
    id: 'conn_001',
    projectId: 'proj_001',
    channelType: 'slack',
    displayName: 'Support Slack Bot',
    externalIdentifier: 'T01ABCDEF',
    hasCredentials: true,
    config: { bot_name: 'AgentBot' },
    identityVerification: {
      providerVerificationStrength: 'weak',
    },
    status: 'active',
    deploymentId: 'dep_001',
    environment: 'production',
    webhookUrl: 'https://runtime.example.com/api/v1/channels/slack/webhook',
    createdAt: '2026-01-10T08:00:00Z',
    updatedAt: '2026-01-18T12:00:00Z',
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub_001',
    channelConnectionId: 'conn_http_001',
    callbackUrl: 'https://api.example.com/hooks/agent',
    events: ['agent.response', 'session.ended'],
    status: 'active',
    description: 'Main webhook endpoint',
    failureCount: 0,
    lastDeliveryAt: '2026-01-19T16:45:00Z',
    agentId: 'agent_001',
    projectId: 'proj_001',
    createdAt: '2026-01-12T09:00:00Z',
    updatedAt: '2026-01-19T16:45:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeSDKChannel
// ---------------------------------------------------------------------------

describe('normalizeSDKChannel', () => {
  it('maps web channelType to sdk_web', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'web' }));
    expect(result.channelType).toBe('sdk_web');
  });

  it('maps mobile_ios to sdk_mobile', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'mobile_ios' }));
    expect(result.channelType).toBe('sdk_mobile');
  });

  it('maps mobile_android to sdk_mobile', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'mobile_android' }));
    expect(result.channelType).toBe('sdk_mobile');
  });

  it('maps api to sdk_api', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'api' }));
    expect(result.channelType).toBe('sdk_api');
  });

  it('maps voice to voice_pipeline', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'voice' }));
    expect(result.channelType).toBe('voice_pipeline');
  });

  it('maps voice_livekit to voice_realtime', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'voice_livekit' }));
    expect(result.channelType).toBe('voice_realtime');
  });

  it('maps voice_twilio to voice_pipeline', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ channelType: 'voice_twilio' }));
    expect(result.channelType).toBe('voice_pipeline');
  });

  it('maps isActive true to active status', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ isActive: true }));
    expect(result.status).toBe('active');
  });

  it('maps isActive false to inactive status', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ isActive: false }));
    expect(result.status).toBe('inactive');
  });

  it('preserves displayName from SDKChannel.name', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ name: 'My Chat Widget' }));
    expect(result.displayName).toBe('My Chat Widget');
  });

  it('prefixes id with sdk_', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ id: 'ch_xyz' }));
    expect(result.id).toBe('sdk_ch_xyz');
  });

  it('sets _source and _sourceId correctly', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel({ id: 'ch_123' }));
    expect(result._source).toBe('sdk_channel');
    expect(result._sourceId).toBe('ch_123');
  });

  it('sets hasCredentials to false for SDK channels', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel());
    expect(result.hasCredentials).toBe(false);
  });

  it('sets externalIdentifier to null for SDK channels', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel());
    expect(result.externalIdentifier).toBeNull();
  });

  it('preserves environment and config', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(
      makeSDKChannel({ environment: 'staging', config: { color: 'blue' } }),
    );
    expect(result.environment).toBe('staging');
    expect(result.config).toEqual({ color: 'blue' });
  });

  it('preserves timestamps', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();
    const result = normalizeSDKChannel(makeSDKChannel());
    expect(result.createdAt).toBe('2026-01-15T10:00:00Z');
    expect(result.updatedAt).toBe('2026-01-20T14:30:00Z');
  });
});

// ---------------------------------------------------------------------------
// normalizeConnection
// ---------------------------------------------------------------------------

describe('normalizeConnection', () => {
  it('maps line channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'line' }));
    expect(result.channelType).toBe('line');
  });

  it('maps slack channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'slack' }));
    expect(result.channelType).toBe('slack');
  });

  it('maps msteams channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'msteams' }));
    expect(result.channelType).toBe('msteams');
  });

  it('maps twilio_sms channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'twilio_sms' }));
    expect(result.channelType).toBe('twilio_sms');
  });

  it('maps zendesk channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'zendesk' }));
    expect(result.channelType).toBe('zendesk');
  });

  it('maps instagram channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'instagram' }));
    expect(result.channelType).toBe('instagram');
  });

  it('maps genesys channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ channelType: 'genesys' }));
    expect(result.channelType).toBe('genesys');
  });

  it('maps email channelType directly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(
      makeConnection({
        channelType: 'email',
        displayName: 'Inbound Email',
        externalIdentifier: 'agent@inbox.example.com',
        hasCredentials: false,
      }),
    );
    expect(result.channelType).toBe('email');
  });

  it('preserves identity verification settings from channel connections', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(
      makeConnection({
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      }),
    );

    expect(result.identityVerification).toEqual({
      providerVerificationStrength: 'strong',
    });
  });

  it('maps active status to active', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ status: 'active' }));
    expect(result.status).toBe('active');
  });

  it('maps error status to error', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ status: 'error' }));
    expect(result.status).toBe('error');
  });

  it('maps unknown status to inactive', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ status: 'inactive' }));
    expect(result.status).toBe('inactive');
  });

  it('maps unrecognized status to inactive', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ status: 'suspended' }));
    expect(result.status).toBe('inactive');
  });

  it('uses displayName from connection when present', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ displayName: 'My Bot' }));
    expect(result.displayName).toBe('My Bot');
  });

  it('falls back to registry name when displayName is null', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ displayName: null, channelType: 'slack' }));
    expect(result.displayName).toBe('Slack');
  });

  it('falls back to channelType string when displayName is null and type not in registry', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(
      makeConnection({ displayName: null, channelType: 'unknown_type' }),
    );
    expect(result.displayName).toBe('unknown_type');
  });

  it('prefixes id with conn_', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ id: 'conn_abc' }));
    expect(result.id).toBe('conn_conn_abc');
  });

  it('sets _source and _sourceId correctly', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ id: 'c99' }));
    expect(result._source).toBe('channel_connection');
    expect(result._sourceId).toBe('c99');
  });

  it('preserves hasCredentials and externalIdentifier', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(
      makeConnection({ hasCredentials: true, externalIdentifier: 'T01XYZ' }),
    );
    expect(result.hasCredentials).toBe(true);
    expect(result.externalIdentifier).toBe('T01XYZ');
  });

  it('sets externalIdentifier to null when empty string', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(makeConnection({ externalIdentifier: '' }));
    expect(result.externalIdentifier).toBeNull();
  });

  it('preserves environment and config', async () => {
    const { normalizeConnection } = await loadNormalizer();
    const result = normalizeConnection(
      makeConnection({ environment: 'staging', config: { auto_reply: true } }),
    );
    expect(result.environment).toBe('staging');
    expect(result.config).toEqual({ auto_reply: true });
  });
});

// ---------------------------------------------------------------------------
// normalizeSubscription
// ---------------------------------------------------------------------------

describe('normalizeSubscription', () => {
  it('always sets channelType to http_async', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription());
    expect(result.channelType).toBe('http_async');
  });

  it('maps active status to active', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ status: 'active' }));
    expect(result.status).toBe('active');
  });

  it('maps paused status to paused', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ status: 'paused' }));
    expect(result.status).toBe('paused');
  });

  it('maps deactivated status to inactive', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ status: 'deactivated' }));
    expect(result.status).toBe('inactive');
  });

  it('uses description as displayName when present', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ description: 'CRM Webhook' }));
    expect(result.displayName).toBe('CRM Webhook');
  });

  it('falls back to callbackUrl when description is null', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(
      makeSubscription({ description: null, callbackUrl: 'https://hook.example.com/events' }),
    );
    expect(result.displayName).toBe('https://hook.example.com/events');
  });

  it('prefixes id with sub_', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ id: 'ws_777' }));
    expect(result.id).toBe('sub_ws_777');
  });

  it('sets _source and _sourceId correctly', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription({ id: 'ws_42' }));
    expect(result._source).toBe('webhook_subscription');
    expect(result._sourceId).toBe('ws_42');
  });

  it('sets externalIdentifier to callbackUrl', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(
      makeSubscription({ callbackUrl: 'https://hooks.myapp.io/v2' }),
    );
    expect(result.externalIdentifier).toBe('https://hooks.myapp.io/v2');
  });

  it('sets environment to null', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription());
    expect(result.environment).toBeNull();
  });

  it('sets hasCredentials to false', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription());
    expect(result.hasCredentials).toBe(false);
  });

  it('includes events and callbackUrl in config', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(
      makeSubscription({
        events: ['agent.response'],
        callbackUrl: 'https://api.example.com/hook',
      }),
    );
    expect(result.config).toEqual({
      events: ['agent.response'],
      callbackUrl: 'https://api.example.com/hook',
    });
  });

  it('preserves timestamps', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const result = normalizeSubscription(makeSubscription());
    expect(result.createdAt).toBe('2026-01-12T09:00:00Z');
    expect(result.updatedAt).toBe('2026-01-19T16:45:00Z');
  });
});

// ---------------------------------------------------------------------------
// normalizeAllInstances
// ---------------------------------------------------------------------------

describe('normalizeAllInstances', () => {
  it('returns an empty map when all inputs are empty', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances([], [], []);
    expect(result.size).toBe(0);
  });

  it('groups SDK channels by channelType', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const sdkChannels = [
      makeSDKChannel({ id: 'a1', channelType: 'web' }),
      makeSDKChannel({ id: 'a2', channelType: 'web' }),
      makeSDKChannel({ id: 'a3', channelType: 'api' }),
    ];
    const result = normalizeAllInstances(sdkChannels, [], []);
    expect(result.get('sdk_web')?.length).toBe(2);
    expect(result.get('sdk_api')?.length).toBe(1);
  });

  it('groups connections by channelType', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const connections = [
      makeConnection({ id: 'c1', channelType: 'slack' }),
      makeConnection({ id: 'c2', channelType: 'slack' }),
      makeConnection({ id: 'c3', channelType: 'msteams' }),
    ];
    const result = normalizeAllInstances([], connections, []);
    expect(result.get('slack')?.length).toBe(2);
    expect(result.get('msteams')?.length).toBe(1);
  });

  it('groups subscriptions under http_async', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const subscriptions = [makeSubscription({ id: 's1' }), makeSubscription({ id: 's2' })];
    const result = normalizeAllInstances([], [], subscriptions);
    expect(result.get('http_async')?.length).toBe(2);
  });

  it('combines all three sources into the same map', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: 'sdk1', channelType: 'web' })],
      [makeConnection({ id: 'conn1', channelType: 'slack' })],
      [makeSubscription({ id: 'sub1' })],
    );
    expect(result.size).toBe(3);
    expect(result.get('sdk_web')?.length).toBe(1);
    expect(result.get('slack')?.length).toBe(1);
    expect(result.get('http_async')?.length).toBe(1);
  });

  it('preserves unique ids across sources', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: '001', channelType: 'web' })],
      [makeConnection({ id: '001', channelType: 'slack' })],
      [makeSubscription({ id: '001' })],
    );
    const allInstances = [...result.values()].flat();
    const ids = allInstances.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('sdk_001');
    expect(ids).toContain('conn_001');
    expect(ids).toContain('sub_001');
  });

  it('correctly counts multiple connections of the same type', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const connections = [
      makeConnection({ id: 'c1', channelType: 'slack', displayName: 'Bot A' }),
      makeConnection({ id: 'c2', channelType: 'slack', displayName: 'Bot B' }),
      makeConnection({ id: 'c3', channelType: 'slack', displayName: 'Bot C' }),
    ];
    const result = normalizeAllInstances([], connections, []);
    const slackInstances = result.get('slack');
    expect(slackInstances?.length).toBe(3);
    expect(slackInstances?.map((i) => i.displayName)).toEqual(['Bot A', 'Bot B', 'Bot C']);
  });
});
