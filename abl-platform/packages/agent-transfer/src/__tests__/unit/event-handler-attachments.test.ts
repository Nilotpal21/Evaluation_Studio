/**
 * Tests for KoreEventHandler attachment extraction (Phase 3).
 *
 * Validates that XO events with attachment data are correctly
 * preserved in the resulting AgentEvent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KoreEventHandler, type XOEvent } from '../../adapters/kore/event-handler.js';
import type { AgentEvent, TransferChannel } from '../../types.js';

// Mock the logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SESSION_CONTEXT = {
  tenantId: 'tenant-1',
  contactId: 'contact-1',
  channel: 'chat' as TransferChannel,
};

describe('KoreEventHandler — attachment extraction', () => {
  let handler: KoreEventHandler;
  let capturedEvents: AgentEvent[];

  beforeEach(() => {
    handler = new KoreEventHandler();
    capturedEvents = [];
    handler.onAgentMessage((event) => {
      capturedEvents.push(event);
    });
  });

  it('preserves attachment data in agentEvent when xoEvent has attachments', async () => {
    const attachments = [
      {
        fileId: 'file-123',
        url: 'https://cdn.example.com/files/report.pdf',
        fileName: 'report.pdf',
        fileType: 'application/pdf',
      },
      {
        fileId: 'file-456',
        url: 'https://cdn.example.com/files/image.png',
        fileName: 'image.png',
        fileType: 'image/png',
      },
    ];

    const xoEvent: XOEvent = {
      type: 'agent_message',
      conversationId: 'conv-abc',
      message: 'Here are the documents you requested',
      data: {
        attachments,
        someOtherField: 'value',
      },
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    expect(event.type).toBe('agent:message');
    expect(event.data.attachments).toEqual(attachments);
    // Verify other data fields are also preserved
    expect(event.data.someOtherField).toBe('value');
    expect(event.data.message).toBe('Here are the documents you requested');
  });

  it('does not add attachments field when xoEvent has no attachments', async () => {
    const xoEvent: XOEvent = {
      type: 'agent_message',
      conversationId: 'conv-def',
      message: 'Plain text message',
      data: {
        someField: 'value',
      },
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    expect(event.data.attachments).toBeUndefined();
  });

  it('does not add attachments when data.attachments is not an array', async () => {
    const xoEvent: XOEvent = {
      type: 'agent_message',
      conversationId: 'conv-ghi',
      message: 'Message with non-array attachments',
      data: {
        attachments: 'not-an-array',
      },
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    // The spread (...xoEvent.data) will include attachments as a string,
    // but the explicit assignment should NOT overwrite it since the condition fails
    // The spread will have set data.attachments = 'not-an-array',
    // and the if-check won't re-assign since Array.isArray('not-an-array') is false
    expect(event.data.attachments).toBe('not-an-array');
  });

  it('preserves empty attachments array from xoEvent', async () => {
    const xoEvent: XOEvent = {
      type: 'agent_message',
      conversationId: 'conv-jkl',
      message: 'Message with empty attachments',
      data: {
        attachments: [],
      },
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    // Empty array is still an array, so the condition passes and it gets set
    expect(event.data.attachments).toEqual([]);
  });

  it('preserves attachments on non-message event types', async () => {
    const attachments = [
      {
        fileId: 'file-789',
        url: 'https://cdn.example.com/files/doc.docx',
        fileName: 'doc.docx',
        fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ];

    const xoEvent: XOEvent = {
      type: 'form_message',
      conversationId: 'conv-mno',
      data: {
        attachments,
        title: 'Upload complete',
      },
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    expect(event.type).toBe('agent:form');
    expect(event.data.attachments).toEqual(attachments);
  });

  it('handles xoEvent with no data field', async () => {
    const xoEvent: XOEvent = {
      type: 'agent_message',
      conversationId: 'conv-pqr',
      message: 'No data field',
    };

    await handler.processEvent(xoEvent, SESSION_CONTEXT);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    expect(event.data.attachments).toBeUndefined();
  });
});
