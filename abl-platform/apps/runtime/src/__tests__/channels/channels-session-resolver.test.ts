/**
 * Channel Session Resolver Tests
 *
 * Covers:
 * - extractCallerContextFromChannel per channel type (Finding 3)
 * - Verifies channel-specific metadata keys map to anonymousId
 * - Verifies unknown channels fall back to externalSessionKey
 */

import { describe, it, expect } from 'vitest';
import { extractCallerContextFromChannel } from '../../channels/session-resolver.js';
import type { ResolvedConnection, NormalizedIncomingMessage } from '../../channels/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: null,
    channelType: 'whatsapp',
    externalIdentifier: 'ext-1',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  } as ResolvedConnection;
}

function makeMessage(
  overrides: Partial<NormalizedIncomingMessage> = {},
): NormalizedIncomingMessage {
  return {
    externalMessageId: 'msg-1',
    externalSessionKey: 'session-key-default',
    text: 'Hello',
    timestamp: new Date(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('extractCallerContextFromChannel', () => {
  it('extracts WhatsApp anonymousId from whatsappFrom metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'whatsapp' }),
      makeMessage({ metadata: { whatsappFrom: '+1234567890' } }),
    );
    expect(result.anonymousId).toBe('+1234567890');
    expect(result.channel).toBe('whatsapp');
  });

  it('extracts Slack anonymousId from slackUserId metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'slack' }),
      makeMessage({ metadata: { slackUserId: 'U12345' } }),
    );
    expect(result.anonymousId).toBe('U12345');
    expect(result.channel).toBe('slack');
  });

  it('extracts LINE anonymousId from lineUserId metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'line' as any }),
      makeMessage({ metadata: { lineUserId: 'Uline-user-1' } }),
    );
    expect(result.anonymousId).toBe('Uline-user-1');
    expect(result.channel).toBe('line');
  });

  it('falls back to externalSessionKey for LINE group and room events without lineUserId', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'line' as any }),
      makeMessage({
        externalSessionKey: 'line:Ubotdestination:group:G1',
        metadata: { lineSourceType: 'group' },
      }),
    );
    expect(result.anonymousId).toBe('line:Ubotdestination:group:G1');
    expect(result.channel).toBe('line');
  });

  it('extracts MS Teams anonymousId from fromId metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'msteams' }),
      makeMessage({ metadata: { fromId: 'teams-user-abc' } }),
    );
    expect(result.anonymousId).toBe('teams-user-abc');
    expect(result.channel).toBe('msteams');
  });

  it('extracts Messenger anonymousId from messengerSenderId metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'messenger' }),
      makeMessage({ metadata: { messengerSenderId: 'psid-123' } }),
    );
    expect(result.anonymousId).toBe('psid-123');
    expect(result.channel).toBe('messenger');
  });

  it('extracts Email anonymousId from from metadata', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'email' }),
      makeMessage({ metadata: { from: 'user@example.com' } }),
    );
    expect(result.anonymousId).toBe('user@example.com');
    expect(result.channel).toBe('email');
  });

  it('falls back to externalSessionKey for unknown channel types', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'http_async' as any }),
      makeMessage({ externalSessionKey: 'custom-key-123' }),
    );
    expect(result.anonymousId).toBe('custom-key-123');
    expect(result.channel).toBe('http_async');
  });

  it('returns undefined anonymousId when metadata key is missing', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'whatsapp' }),
      makeMessage({ metadata: {} }),
    );
    expect(result.anonymousId).toBeUndefined();
    expect(result.channel).toBe('whatsapp');
  });

  it('returns undefined anonymousId when metadata is absent', () => {
    const result = extractCallerContextFromChannel(
      makeConnection({ channelType: 'slack' }),
      makeMessage({}), // no metadata field
    );
    expect(result.anonymousId).toBeUndefined();
    expect(result.channel).toBe('slack');
  });
});
