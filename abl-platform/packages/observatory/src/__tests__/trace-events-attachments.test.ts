import { describe, it, expect } from 'vitest';
import { ALL_TRACE_EVENT_TYPES, createTraceEvent } from '../schema/trace-events.js';
import type {
  TraceEventType,
  AttachmentUploadData,
  AttachmentScanData,
  AttachmentProcessData,
  AttachmentIndexData,
  AttachmentDeleteData,
} from '../schema/trace-events.js';

describe('Attachment Trace Events', () => {
  const attachmentEventTypes: TraceEventType[] = [
    'attachment_upload',
    'attachment_scan',
    'attachment_process',
    'attachment_index',
    'attachment_delete',
  ];

  it('includes all attachment event types in ALL_TRACE_EVENT_TYPES', () => {
    for (const type of attachmentEventTypes) {
      expect(ALL_TRACE_EVENT_TYPES).toContain(type);
    }
  });

  it('creates attachment_upload trace event', () => {
    const data: AttachmentUploadData = {
      attachmentId: 'att-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      filename: 'photo.png',
      mimeType: 'image/png',
      category: 'image',
      sizeBytes: 1024,
      storageProvider: 's3',
      deduplicated: false,
    };

    const event = createTraceEvent({
      type: 'attachment_upload',
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentName: 'multimodal-service',
      data,
    });

    expect(event.type).toBe('attachment_upload');
    expect(event.id).toBeDefined();
    expect(event.spanId).toBeDefined();
  });

  it('creates attachment_scan trace event', () => {
    const data: AttachmentScanData = {
      attachmentId: 'att-1',
      tenantId: 'tenant-1',
      scanStatus: 'clean',
      engine: 'clamav',
    };

    const event = createTraceEvent({
      type: 'attachment_scan',
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentName: 'multimodal-service',
      data,
    });

    expect(event.type).toBe('attachment_scan');
  });

  it('creates attachment_process trace event', () => {
    const data: AttachmentProcessData = {
      attachmentId: 'att-1',
      tenantId: 'tenant-1',
      category: 'image',
      processingEngine: 'sharp',
      processingStatus: 'completed',
      outputKeys: ['resized', 'thumbnail'],
    };

    const event = createTraceEvent({
      type: 'attachment_process',
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentName: 'multimodal-service',
      data,
    });

    expect(event.type).toBe('attachment_process');
  });

  it('creates attachment_index trace event', () => {
    const data: AttachmentIndexData = {
      attachmentId: 'att-1',
      tenantId: 'tenant-1',
      searchIndexId: 'idx-1',
      searchDocumentId: 'doc-1',
      embeddingStatus: 'completed',
    };

    const event = createTraceEvent({
      type: 'attachment_index',
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentName: 'multimodal-service',
      data,
    });

    expect(event.type).toBe('attachment_index');
  });

  it('creates attachment_delete trace event', () => {
    const data: AttachmentDeleteData = {
      attachmentId: 'att-1',
      tenantId: 'tenant-1',
      reason: 'session_cascade',
      storageKeysDeleted: 3,
    };

    const event = createTraceEvent({
      type: 'attachment_delete',
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentName: 'multimodal-service',
      data,
    });

    expect(event.type).toBe('attachment_delete');
  });

  it('total event types count is correct', () => {
    expect(new Set(ALL_TRACE_EVENT_TYPES).size).toBe(ALL_TRACE_EVENT_TYPES.length);
  });
});
