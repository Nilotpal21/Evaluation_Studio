import { describe, it, expect } from 'vitest';
import type { SDKChannel } from '../api/channels';
import type { ChannelConnectionSummary } from '../api/channel-connections';
import type { WebhookSubscription } from '../api/http-async-channels';
import type {
  ChannelTypeId,
  ChannelCategory,
  ChannelNavLevel,
} from '../components/deployments/channels/types';

// Dynamic imports to avoid JSX resolution from channel-registry (React elements)
async function loadRegistry() {
  return import('../components/deployments/channels/channel-registry');
}

async function loadNormalizer() {
  return import('../components/deployments/channels/channel-normalizer');
}

// ---------------------------------------------------------------------------
// Test fixtures (same helpers as channel-normalizer tests)
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

// ===========================================================================
// 1. Registry-Normalizer Consistency
// ===========================================================================

describe('Registry-Normalizer consistency', () => {
  it('CHANNEL_CATALOG_ORDER contains exactly the same set of IDs as CHANNEL_REGISTRY keys', async () => {
    const { CHANNEL_REGISTRY, CHANNEL_CATALOG_ORDER } = await loadRegistry();
    const registryKeys = new Set(Object.keys(CHANNEL_REGISTRY));
    const orderKeys = new Set(CHANNEL_CATALOG_ORDER);
    expect(orderKeys).toEqual(registryKeys);
  });

  it('CHANNEL_CATALOG_ORDER has no duplicate entries', async () => {
    const { CHANNEL_CATALOG_ORDER } = await loadRegistry();
    expect(new Set(CHANNEL_CATALOG_ORDER).size).toBe(CHANNEL_CATALOG_ORDER.length);
  });

  it('every channel type with hasCredentials=true has at least one credentialFields entry', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      if (def.capabilities.hasCredentials && def.available) {
        expect(
          def.credentialFields.length,
          `${id} has hasCredentials=true and is available but zero credentialFields`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('every available channel type with hasCredentials=false has zero credentialFields', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      if (!def.capabilities.hasCredentials) {
        expect(
          def.credentialFields.length,
          `${id} has hasCredentials=false but has credentialFields`,
        ).toBe(0);
      }
    }
  });

  it('no duplicate credential field keys within any single channel type', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      const keys = def.credentialFields.map((f: { key: string }) => f.key);
      expect(new Set(keys).size, `${id} has duplicate credential field keys`).toBe(keys.length);
    }
  });

  it('normalizer produces instances for connection-based channel types found in the registry', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    const { normalizeConnection } = await loadNormalizer();

    // Connection-based types are messaging channels: slack, msteams, email, whatsapp, messenger
    const connectionTypes = Object.entries(CHANNEL_REGISTRY)
      .filter(([, def]) => def.category === 'messaging')
      .map(([id]) => id);

    for (const channelType of connectionTypes) {
      const instance = normalizeConnection(makeConnection({ channelType }));
      expect(instance.channelType).toBe(channelType);
      expect(instance._source).toBe('channel_connection');
    }
  });

  it('normalizer produces instances for SDK-based channel types found in the registry', async () => {
    const { normalizeSDKChannel } = await loadNormalizer();

    // SDK type mappings: web->sdk_web, api->sdk_api, mobile_ios->sdk_mobile, voice->voice_pipeline
    const sdkMappings: Array<{
      sdkType: SDKChannel['channelType'];
      expectedTypeId: ChannelTypeId;
    }> = [
      { sdkType: 'web', expectedTypeId: 'sdk_web' },
      { sdkType: 'api', expectedTypeId: 'sdk_api' },
      { sdkType: 'mobile_ios', expectedTypeId: 'sdk_mobile' },
      { sdkType: 'mobile_android', expectedTypeId: 'sdk_mobile' },
      { sdkType: 'voice', expectedTypeId: 'voice_pipeline' },
      { sdkType: 'voice_livekit', expectedTypeId: 'voice_realtime' },
      { sdkType: 'voice_twilio', expectedTypeId: 'voice_pipeline' },
    ];

    for (const { sdkType, expectedTypeId } of sdkMappings) {
      const instance = normalizeSDKChannel(makeSDKChannel({ channelType: sdkType }));
      expect(instance.channelType).toBe(expectedTypeId);
      expect(instance._source).toBe('sdk_channel');
    }
  });

  it('normalizer produces http_async instances for webhook subscriptions', async () => {
    const { normalizeSubscription } = await loadNormalizer();
    const instance = normalizeSubscription(makeSubscription());
    expect(instance.channelType).toBe('http_async');
    expect(instance._source).toBe('webhook_subscription');
  });
});

// ===========================================================================
// 2. Types Consistency
// ===========================================================================

describe('Types consistency', () => {
  const VALID_CATEGORIES: ChannelCategory[] = ['messaging', 'sdk', 'webhook', 'voice', 'protocol'];

  it('all channel categories in the registry are valid', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(VALID_CATEGORIES, `${id} has invalid category: ${def.category}`).toContain(
        def.category,
      );
    }
  });

  it('every channel type has a non-empty name', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(def.name.length, `${id} has empty name`).toBeGreaterThan(0);
    }
  });

  it('every channel type has a non-empty description', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(def.description.length, `${id} has empty description`).toBeGreaterThan(0);
    }
  });

  it('every channel type has a non-empty externalIdentifierLabel', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(
        def.externalIdentifierLabel.length,
        `${id} has empty externalIdentifierLabel`,
      ).toBeGreaterThan(0);
    }
  });

  it('every channel type id in the registry matches its key', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    for (const [key, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(def.id, `Registry key ${key} does not match def.id ${def.id}`).toBe(key);
    }
  });

  it('all expected channel types are present in the registry', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    const expectedTypes: ChannelTypeId[] = [
      'slack',
      'line',
      'msteams',
      'email',
      'whatsapp',
      'messenger',
      'twilio_sms',
      'telegram',
      'zendesk',
      'instagram',
      'genesys',
      'ai4w',
      'sdk_web',
      'sdk_mobile',
      'sdk_api',
      'http_async',
      'voice_realtime',
      'voice_pipeline',
      'voice_vxml',
      'ag_ui',
      'audiocodes',
      'a2a',
    ];
    for (const typeId of expectedTypes) {
      expect(CHANNEL_REGISTRY[typeId], `Missing registry entry for ${typeId}`).toBeDefined();
    }
    expect(Object.keys(CHANNEL_REGISTRY).length).toBe(expectedTypes.length);
  });
});

// ===========================================================================
// 3. Navigation Type Safety
// ===========================================================================

describe('Navigation type safety (ChannelNavLevel)', () => {
  it('catalog level has only level field', () => {
    const nav: ChannelNavLevel = { level: 'catalog' };
    expect(nav.level).toBe('catalog');
    expect('channelType' in nav).toBe(false);
    expect('instanceId' in nav).toBe(false);
  });

  it('list level has level and channelType', () => {
    const nav: ChannelNavLevel = { level: 'list', channelType: 'slack' };
    expect(nav.level).toBe('list');
    expect(nav.channelType).toBe('slack');
    expect('instanceId' in nav).toBe(false);
  });

  it('config level has level, channelType, and instanceId', () => {
    const nav: ChannelNavLevel = {
      level: 'config',
      channelType: 'slack',
      instanceId: 'conn_001',
    };
    expect(nav.level).toBe('config');
    expect(nav.channelType).toBe('slack');
    expect(nav.instanceId).toBe('conn_001');
  });

  it('discriminates correctly using switch on level', () => {
    const navs: ChannelNavLevel[] = [
      { level: 'catalog' },
      { level: 'list', channelType: 'sdk_web' },
      { level: 'config', channelType: 'http_async', instanceId: 'sub_001' },
    ];

    const results: string[] = [];
    for (const nav of navs) {
      switch (nav.level) {
        case 'catalog':
          results.push('catalog');
          break;
        case 'list':
          results.push(`list:${nav.channelType}`);
          break;
        case 'config':
          results.push(`config:${nav.channelType}:${nav.instanceId}`);
          break;
      }
    }

    expect(results).toEqual(['catalog', 'list:sdk_web', 'config:http_async:sub_001']);
  });
});

// ===========================================================================
// 4. Normalizer Integration
// ===========================================================================

describe('Normalizer integration', () => {
  it('normalizeAllInstances returns a Map keyed by ChannelTypeId', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: 'sdk1', channelType: 'web' })],
      [makeConnection({ id: 'conn1', channelType: 'slack' })],
      [makeSubscription({ id: 'sub1' })],
    );
    expect(result).toBeInstanceOf(Map);
    // Verify each key is a valid ChannelTypeId string
    for (const key of result.keys()) {
      expect(typeof key).toBe('string');
    }
  });

  it('empty inputs produce empty Map', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances([], [], []);
    expect(result.size).toBe(0);
  });

  it('mixed inputs from all three sources produce correctly keyed entries', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [
        makeSDKChannel({ id: 'w1', channelType: 'web' }),
        makeSDKChannel({ id: 'w2', channelType: 'web' }),
        makeSDKChannel({ id: 'a1', channelType: 'api' }),
        makeSDKChannel({ id: 'm1', channelType: 'mobile_ios' }),
        makeSDKChannel({ id: 'v1', channelType: 'voice' }),
      ],
      [
        makeConnection({ id: 's1', channelType: 'slack' }),
        makeConnection({ id: 's2', channelType: 'slack' }),
        makeConnection({ id: 't1', channelType: 'msteams' }),
        makeConnection({ id: 'e1', channelType: 'email' }),
      ],
      [
        makeSubscription({ id: 'h1' }),
        makeSubscription({ id: 'h2' }),
        makeSubscription({ id: 'h3' }),
      ],
    );

    // Verify grouping counts
    expect(result.get('sdk_web')?.length).toBe(2);
    expect(result.get('sdk_api')?.length).toBe(1);
    expect(result.get('sdk_mobile')?.length).toBe(1);
    expect(result.get('voice_pipeline')?.length).toBe(1);
    expect(result.get('slack')?.length).toBe(2);
    expect(result.get('msteams')?.length).toBe(1);
    expect(result.get('email')?.length).toBe(1);
    expect(result.get('http_async')?.length).toBe(3);

    // Total distinct channel types
    expect(result.size).toBe(8);
  });

  it('ID prefixing is consistent: sdk_ for SDK, conn_ for connections, sub_ for subscriptions', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: 'alpha', channelType: 'web' })],
      [makeConnection({ id: 'beta', channelType: 'slack' })],
      [makeSubscription({ id: 'gamma' })],
    );

    const allInstances = [...result.values()].flat();
    const sdkInstance = allInstances.find((i) => i._source === 'sdk_channel');
    const connInstance = allInstances.find((i) => i._source === 'channel_connection');
    const subInstance = allInstances.find((i) => i._source === 'webhook_subscription');

    expect(sdkInstance?.id).toBe('sdk_alpha');
    expect(sdkInstance?._sourceId).toBe('alpha');

    expect(connInstance?.id).toBe('conn_beta');
    expect(connInstance?._sourceId).toBe('beta');

    expect(subInstance?.id).toBe('sub_gamma');
    expect(subInstance?._sourceId).toBe('gamma');
  });

  it('same raw ID from different sources produces unique prefixed IDs', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: 'same_id', channelType: 'web' })],
      [makeConnection({ id: 'same_id', channelType: 'slack' })],
      [makeSubscription({ id: 'same_id' })],
    );

    const allInstances = [...result.values()].flat();
    const ids = allInstances.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('sdk_same_id');
    expect(ids).toContain('conn_same_id');
    expect(ids).toContain('sub_same_id');
  });

  it('all normalized instances have required ChannelInstance fields', async () => {
    const { normalizeAllInstances } = await loadNormalizer();
    const result = normalizeAllInstances(
      [makeSDKChannel({ id: 'sdk1', channelType: 'web' })],
      [makeConnection({ id: 'conn1', channelType: 'slack' })],
      [makeSubscription({ id: 'sub1' })],
    );

    const allInstances = [...result.values()].flat();
    for (const instance of allInstances) {
      expect(typeof instance.id).toBe('string');
      expect(typeof instance.channelType).toBe('string');
      expect(typeof instance.displayName).toBe('string');
      expect(['active', 'inactive', 'error', 'paused']).toContain(instance.status);
      expect(typeof instance.hasCredentials).toBe('boolean');
      expect(typeof instance.config).toBe('object');
      expect(typeof instance.createdAt).toBe('string');
      expect(typeof instance.updatedAt).toBe('string');
      expect(['sdk_channel', 'channel_connection', 'webhook_subscription']).toContain(
        instance._source,
      );
      expect(typeof instance._sourceId).toBe('string');
    }
  });

  it('all normalized channelType values exist in the registry', async () => {
    const { CHANNEL_REGISTRY } = await loadRegistry();
    const { normalizeAllInstances } = await loadNormalizer();

    const result = normalizeAllInstances(
      [
        makeSDKChannel({ id: 'w1', channelType: 'web' }),
        makeSDKChannel({ id: 'a1', channelType: 'api' }),
        makeSDKChannel({ id: 'm1', channelType: 'mobile_ios' }),
        makeSDKChannel({ id: 'v1', channelType: 'voice' }),
      ],
      [
        makeConnection({ id: 's1', channelType: 'slack' }),
        makeConnection({ id: 't1', channelType: 'msteams' }),
        makeConnection({ id: 'e1', channelType: 'email' }),
      ],
      [makeSubscription({ id: 'h1' })],
    );

    const registryKeys = new Set(Object.keys(CHANNEL_REGISTRY));
    for (const [channelType] of result) {
      expect(
        registryKeys.has(channelType),
        `Normalized channelType "${channelType}" not found in registry`,
      ).toBe(true);
    }
  });
});
