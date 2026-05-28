import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consentLean: vi.fn(),
  messageFind: vi.fn(),
  settings: vi.fn(),
  addParticipant: vi.fn(),
  getLiveSession: vi.fn(),
  getParticipants: vi.fn(),
  redeemJoinToken: vi.fn(),
  emitAudit: vi.fn(),
  buildProjectPIIReadSurfaceContext: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ContactCapabilityConsent: {
    findOne: vi.fn(() => ({
      lean: mocks.consentLean,
    })),
  },
  Message: {
    find: (...args: unknown[]) => mocks.messageFind(...args),
  },
}));

vi.mock('../../services/omnichannel/omnichannel-settings-service.js', () => ({
  getOmnichannelSettings: (...args: unknown[]) => mocks.settings(...args),
}));

vi.mock('../../services/omnichannel/omnichannel-audit.js', () => ({
  emitOmnichannelAudit: (...args: unknown[]) => mocks.emitAudit(...args),
}));

vi.mock('../../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  buildProjectPIIReadSurfaceContext: (...args: unknown[]) =>
    mocks.buildProjectPIIReadSurfaceContext(...args),
}));

vi.mock('../../services/omnichannel/participant-registry.js', () => ({
  addParticipant: (...args: unknown[]) => mocks.addParticipant(...args),
  getLiveSession: (...args: unknown[]) => mocks.getLiveSession(...args),
  getParticipants: (...args: unknown[]) => mocks.getParticipants(...args),
  redeemJoinToken: (...args: unknown[]) => mocks.redeemJoinToken(...args),
}));

describe('omnichannel live session backfill', () => {
  function createContractPIIReadSurfaceContext() {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );

    return {
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiVault: new PIIVault({ recognizerRegistry: registry }),
      piiPatternConfigs: [
        {
          patternName: 'ContractID',
          defaultRenderMode: 'redacted' as const,
          consumerAccess: [],
          redactionLabel: '[REDACTED_CONTRACT_ID]',
        },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consentLean.mockResolvedValue({ _id: 'consent-1' });
    mocks.settings.mockResolvedValue({
      liveSync: { enabled: true },
      recall: { maxMessages: 5 },
    });
    mocks.getLiveSession.mockResolvedValue('session-1');
    mocks.addParticipant.mockResolvedValue(undefined);
    mocks.getParticipants.mockResolvedValue([
      {
        participantId: 'participant-1',
        sessionId: 'session-1',
        contactId: 'contact-1',
        surface: 'web',
        channel: 'text',
        mode: 'typed',
        interactive: true,
        attachedAt: new Date('2026-05-02T10:00:00.000Z'),
      },
    ]);
    mocks.redeemJoinToken.mockResolvedValue(null);
    mocks.emitAudit.mockResolvedValue(undefined);
    mocks.buildProjectPIIReadSurfaceContext.mockResolvedValue(undefined);
    mocks.messageFind.mockImplementation(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([
          {
            _id: 'msg-2',
            sessionId: 'session-1',
            role: 'assistant',
            content: 'AI answer',
            channel: 'web_chat',
            sourceChannel: 'text',
            inputMode: 'typed',
            sequence: 2,
            timestamp: new Date('2026-05-02T10:02:00.000Z'),
            final: true,
            metadata: JSON.stringify({
              isLlmGenerated: true,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'llm',
                disclaimerRequired: true,
                usedLlmInternally: true,
              },
            }),
          },
          {
            _id: 'msg-1',
            sessionId: 'session-1',
            role: 'user',
            content: 'Hello',
            channel: 'web_chat',
            sourceChannel: 'text',
            inputMode: 'typed',
            sequence: 1,
            timestamp: new Date('2026-05-02T10:01:00.000Z'),
            final: true,
            metadata: { preserved: true },
          },
        ]),
      })),
    }));
  });

  it('preserves assistant response metadata in transcript backfill', async () => {
    const { joinLiveSession } = await import('../../services/omnichannel/live-session-service.js');

    const result = await joinLiveSession(
      'tenant-1',
      'project-1',
      'session-1',
      {
        participantId: 'participant-1',
        sessionId: 'session-1',
        contactId: 'contact-1',
        surface: 'web',
        channel: 'text',
        mode: 'typed',
        interactive: true,
        attachedAt: new Date('2026-05-02T10:00:00.000Z'),
      },
      'contact-1',
      2,
    );

    expect(result.success).toBe(true);
    expect(result.backfill).toHaveLength(2);
    expect(result.backfill[0]).toMatchObject({
      id: 'msg-1',
      metadata: { preserved: true },
    });
    expect(result.backfill[1]).toMatchObject({
      id: 'msg-2',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    });
  });

  it('redacts custom project patterns in transcript backfill', async () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    mocks.buildProjectPIIReadSurfaceContext.mockResolvedValue(
      createContractPIIReadSurfaceContext(),
    );
    mocks.messageFind.mockImplementationOnce(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([
          {
            _id: 'msg-contract',
            sessionId: 'session-1',
            role: 'user',
            content: `Contract ${rawContractId}`,
            channel: 'web_chat',
            sourceChannel: 'text',
            inputMode: 'typed',
            sequence: 1,
            timestamp: new Date('2026-05-02T10:01:00.000Z'),
            final: true,
          },
        ]),
      })),
    }));

    const { joinLiveSession } = await import('../../services/omnichannel/live-session-service.js');

    const result = await joinLiveSession(
      'tenant-1',
      'project-1',
      'session-1',
      {
        participantId: 'participant-1',
        sessionId: 'session-1',
        contactId: 'contact-1',
        surface: 'web',
        channel: 'text',
        mode: 'typed',
        interactive: true,
        attachedAt: new Date('2026-05-02T10:00:00.000Z'),
      },
      'contact-1',
      2,
    );

    expect(result.success).toBe(true);
    expect(result.backfill).toHaveLength(1);
    expect(result.backfill[0].content).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(result.backfill[0].content).not.toContain(rawContractId);
  });
});
