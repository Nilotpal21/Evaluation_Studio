import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFlushMessageQueue, mockPersistMessageRecord } = vi.hoisted(() => ({
  mockFlushMessageQueue: vi.fn(),
  mockPersistMessageRecord: vi.fn(),
}));

const { mockFindLatestMessageForSession } = vi.hoisted(() => ({
  mockFindLatestMessageForSession: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../message-persistence-queue.js', () => ({
  flushMessageQueue: (...args: unknown[]) => mockFlushMessageQueue(...args),
  persistMessageRecord: (...args: unknown[]) => mockPersistMessageRecord(...args),
}));

vi.mock('../../../repos/session-repo.js', () => ({
  findLatestMessageForSession: (...args: unknown[]) => mockFindLatestMessageForSession(...args),
}));

import type { EventStoreServices } from '@abl/eventstore';
import { AgentTransferTranscriptPersistenceService } from '../transcript-persistence.js';

describe('AgentTransferTranscriptPersistenceService', () => {
  const service = new AgentTransferTranscriptPersistenceService();

  beforeEach(() => {
    mockFlushMessageQueue.mockReset().mockResolvedValue(undefined);
    mockPersistMessageRecord.mockReset().mockResolvedValue(undefined);
    mockFindLatestMessageForSession.mockReset().mockResolvedValue(null);
  });

  it('persists forwarded user messages to the parent conversation session', async () => {
    await service.persistForwardedUserMessage({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      content: 'I need help with billing',
      traceId: 'trace-1',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledWith({
      dbSessionId: 'conversation-1',
      role: 'user',
      content: 'I need help with billing',
      channel: 'web_debug',
      tenantId: 'tenant-1',
      traceId: 'trace-1',
      contactId: 'contact-1',
      projectId: 'project-1',
      messageTimestamp: undefined,
      metadata: {
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
          provider: 'smartassist',
          providerSessionId: 'provider-1',
          participantType: 'user',
          direction: 'user_to_agent',
          transferState: 'active',
        },
      },
    });
  });

  it('persists delivered voice agent events with TTS metadata', async () => {
    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-voice-1:voice',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-voice-1',
        contactId: 'caller-1',
        channel: 'voice',
        provider: 'smartassist',
        providerSessionId: 'provider-voice-1',
        state: 'active',
        metadata: {
          conversationSessionId: 'voice-parent-1',
        },
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-voice-1',
          normalizedTransferChannel: 'voice',
          sourceChannelType: 'korevg',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 0,
        projectId: 'project-1',
      },
      event: {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:runtime-voice-1:voice',
        tenantId: 'tenant-1',
        contactId: 'caller-1',
        channel: 'voice',
        timestamp: '2026-04-24T10:20:30.000Z',
        data: {
          aId: 'a-b95a117-4456-424a-8cb8-9a1ebb4917d4',
          acwCloseReason: 'agent_closed',
          closeStatus: 'Resolved',
          closeRemarks: 'Resolved - shared travel plan',
          csatRequested: true,
          csatRequired: true,
          csatSurveyType: 'csat',
          event: 'closed',
          metaStatus: 'AGENT_CLOSED',
          message: 'Connecting you to an agent now.',
          agentInfo: { displayName: 'Jamie Agent' },
          value: 'Connecting you to an agent now.',
        },
      },
      content: 'Connecting you to an agent now.',
      deliveryChannel: 'voice_gateway',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledWith({
      dbSessionId: 'voice-parent-1',
      role: 'assistant',
      content: 'Connecting you to an agent now.',
      channel: 'voice',
      tenantId: 'tenant-1',
      traceId: undefined,
      contactId: 'caller-1',
      projectId: 'project-1',
      messageTimestamp: Date.parse('2026-04-24T10:20:30.000Z'),
      metadata: {
        voiceType: 'tts',
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:runtime-voice-1:voice',
          provider: 'smartassist',
          providerSessionId: 'provider-voice-1',
          participantType: 'human_agent',
          direction: 'agent_to_user',
          transferState: 'active',
          deliveryChannel: 'voice_gateway',
          eventType: 'agent:message',
          agentInfo: { displayName: 'Jamie Agent' },
          providerEventData: {
            aId: 'a-b95a117-4456-424a-8cb8-9a1ebb4917d4',
            acwCloseReason: 'agent_closed',
            closeStatus: 'Resolved',
            closeRemarks: 'Resolved - shared travel plan',
            csatRequested: true,
            csatRequired: true,
            csatSurveyType: 'csat',
            event: 'closed',
            message: 'Connecting you to an agent now.',
            metaStatus: 'AGENT_CLOSED',
          },
        },
      },
    });
  });

  it('omits providerEventData when the event has no allowlisted provider fields', async () => {
    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      event: {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-04-24T10:20:30.000Z',
        data: {
          agentInfo: { displayName: 'Jamie Agent' },
          value: 'Duplicate provider text',
        },
      },
      content: 'Delivered from channel adapter',
      deliveryChannel: 'websocket',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledWith({
      dbSessionId: 'conversation-1',
      role: 'assistant',
      content: 'Delivered from channel adapter',
      channel: 'web_debug',
      tenantId: 'tenant-1',
      traceId: undefined,
      contactId: 'contact-1',
      projectId: 'project-1',
      messageTimestamp: Date.parse('2026-04-24T10:20:30.000Z'),
      metadata: {
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
          provider: 'smartassist',
          providerSessionId: 'provider-1',
          participantType: 'human_agent',
          direction: 'agent_to_user',
          transferState: 'active',
          deliveryChannel: 'websocket',
          eventType: 'agent:message',
          agentInfo: { displayName: 'Jamie Agent' },
        },
      },
    });
  });

  it('persists fallback provider content fields for delivered agent events', async () => {
    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      event: {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-04-24T10:20:30.000Z',
        data: {
          text: 'Template text content',
          body: 'Body fallback content',
          csatMessage: { value: 'Please rate your experience' },
          surveyType: 'nps',
          unsafeProviderField: 'drop me',
        },
      },
      content: 'Template text content',
      deliveryChannel: 'websocket',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          custom: expect.objectContaining({
            providerEventData: {
              text: 'Template text content',
              body: 'Body fallback content',
              csatMessage: { value: 'Please rate your experience' },
              surveyType: 'nps',
            },
          }),
        },
      }),
    );
  });

  it('persists bridged voice agent transcripts with ASR metadata', async () => {
    await service.persistObservedAgentTranscript({
      transferSessionId: 'agent_transfer:tenant-1:runtime-voice-1:voice',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-voice-1',
        contactId: 'caller-1',
        channel: 'voice',
        provider: 'smartassist',
        providerSessionId: 'provider-voice-1',
        state: 'active',
        metadata: {
          conversationSessionId: 'voice-parent-1',
        },
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-voice-1',
          normalizedTransferChannel: 'voice',
          sourceChannelType: 'korevg',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 0,
        projectId: 'project-1',
      },
      content: 'I am here to help you now.',
      messageTimestamp: Date.parse('2026-04-24T10:21:00.000Z'),
      agentInfo: { memberId: 'agent-member-1' },
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledWith({
      dbSessionId: 'voice-parent-1',
      role: 'assistant',
      content: 'I am here to help you now.',
      channel: 'voice',
      tenantId: 'tenant-1',
      traceId: undefined,
      contactId: 'caller-1',
      projectId: 'project-1',
      messageTimestamp: Date.parse('2026-04-24T10:21:00.000Z'),
      metadata: {
        voiceType: 'asr',
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:runtime-voice-1:voice',
          provider: 'smartassist',
          providerSessionId: 'provider-voice-1',
          participantType: 'human_agent',
          direction: 'agent_to_user',
          transferState: 'active',
          eventType: 'agent:message',
          agentInfo: { memberId: 'agent-member-1' },
        },
      },
    });
  });

  it('skips duplicate delivered agent events for the same transfer session', async () => {
    mockFindLatestMessageForSession.mockResolvedValue({
      id: 'message-1',
      role: 'assistant',
      content: 'Appointment confirmed',
      timestamp: new Date('2026-04-25T12:00:05.000Z'),
      metadata: {
        custom: {
          source: 'agent-transfer',
          transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
          direction: 'agent_to_user',
        },
      },
    });

    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      event: {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-04-25T12:00:10.000Z',
        data: {
          message: 'Appointment confirmed',
        },
      },
      content: 'Appointment confirmed',
      deliveryChannel: 'websocket',
    });

    expect(mockPersistMessageRecord).not.toHaveBeenCalled();
    expect(mockFindLatestMessageForSession).toHaveBeenCalledWith('conversation-1', 'tenant-1');
  });

  it('skips delivered agent events when the event tenant does not match the transfer session tenant', async () => {
    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      event: {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        tenantId: 'tenant-2',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-04-25T12:00:10.000Z',
        data: {
          message: 'Appointment confirmed',
        },
      },
      content: 'Appointment confirmed',
      deliveryChannel: 'websocket',
    });

    expect(mockFindLatestMessageForSession).not.toHaveBeenCalled();
    expect(mockPersistMessageRecord).not.toHaveBeenCalled();
  });

  it('skips transfer transcript writes without tenant scope', async () => {
    await service.persistForwardedUserMessage({
      transferSessionId: 'agent_transfer:missing-tenant:runtime-1:chat',
      transferSession: {
        tenantId: '',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      content: 'I need help with billing',
      traceId: 'trace-1',
    });

    expect(mockFindLatestMessageForSession).not.toHaveBeenCalled();
    expect(mockPersistMessageRecord).not.toHaveBeenCalled();
  });

  it('flushes resolved transcript session ids through the message queue', async () => {
    await service.flushTransferTranscriptQueue({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      },
      runtimeSessionId: 'runtime-1',
      reason: 'transfer_session_end',
    });

    expect(mockFlushMessageQueue).toHaveBeenCalledWith('conversation-1');
    expect(mockFlushMessageQueue).toHaveBeenCalledWith('runtime-1');
  });

  it('skips transcript queue flush without any parent session candidate', async () => {
    await service.flushTransferTranscriptQueue({
      reason: 'transfer_session_end',
    });

    expect(mockFlushMessageQueue).not.toHaveBeenCalled();
  });

  describe('EventStore emit for transfer messages', () => {
    let mockEmitFn: ReturnType<typeof vi.fn>;

    const baseTransferSession = {
      tenantId: 'tenant-1',
      ownerId: 'runtime-1',
      contactId: 'contact-1',
      channel: 'chat',
      provider: 'smartassist',
      providerSessionId: 'provider-1',
      state: 'active',
      metadata: {},
      providerData: {},
      routing: {
        runtimeSessionId: 'runtime-1',
        conversationSessionId: 'conversation-1',
        resolvedContactId: 'contact-1',
        normalizedTransferChannel: 'chat',
        sourceChannelType: 'sdk_websocket',
      },
      ownerPod: 'pod-1',
      lastHeartbeat: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ttl: 1800,
      projectId: 'project-1',
    };

    beforeEach(() => {
      mockEmitFn = vi.fn();
      mockPersistMessageRecord.mockReset().mockResolvedValue(undefined);
      mockFindLatestMessageForSession.mockReset().mockResolvedValue(null);
    });

    function createMockEventStore(): EventStoreServices {
      return { emitter: { emit: mockEmitFn } } as unknown as EventStoreServices;
    }

    it('emits user_message to EventStore after user message persistence', async () => {
      const eventStoreService = new AgentTransferTranscriptPersistenceService(() =>
        createMockEventStore(),
      );

      await eventStoreService.persistForwardedUserMessage({
        transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        transferSession: baseTransferSession as any,
        content: 'Hello',
      });

      expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
      expect(mockEmitFn).toHaveBeenCalledOnce();
      expect(mockEmitFn).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: expect.any(String),
          tenant_id: 'tenant-1',
          project_id: 'project-1',
          session_id: 'conversation-1',
          data: expect.objectContaining({
            contentLength: 5,
            channel: 'web_debug',
            participantType: 'user',
            source: 'agent-transfer',
            transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
            provider: 'smartassist',
          }),
        }),
      );
    });

    it('emits agent_response to EventStore after agent message persistence', async () => {
      const eventStoreService = new AgentTransferTranscriptPersistenceService(() =>
        createMockEventStore(),
      );

      await eventStoreService.persistDeliveredAgentEvent({
        transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        transferSession: baseTransferSession as any,
        event: {
          type: 'agent:message',
          sessionId: 'agent_transfer:tenant-1:runtime-1:chat',
          tenantId: 'tenant-1',
          contactId: 'contact-1',
          channel: 'chat',
          timestamp: '2026-05-16T10:00:00.000Z',
          data: {
            message: 'Hi there',
          },
        },
        content: 'Hi there',
        deliveryChannel: 'websocket',
      });

      expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
      expect(mockEmitFn).toHaveBeenCalledOnce();
      expect(mockEmitFn).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: expect.any(String),
          tenant_id: 'tenant-1',
          project_id: 'project-1',
          session_id: 'conversation-1',
          data: expect.objectContaining({
            contentLength: 8,
            channel: 'web_debug',
            participantType: 'human_agent',
            source: 'agent-transfer',
            transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
            provider: 'smartassist',
          }),
        }),
      );
    });

    it('skips EventStore emit when getEventStoreFn returns null', async () => {
      const eventStoreService = new AgentTransferTranscriptPersistenceService(() => null);

      await eventStoreService.persistForwardedUserMessage({
        transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
        transferSession: baseTransferSession as any,
        content: 'Hi',
      });

      expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
      expect(mockEmitFn).not.toHaveBeenCalled();
    });
  });
});
