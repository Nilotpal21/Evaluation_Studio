import { describe, expect, it } from 'vitest';
import {
  stripInternalInlineTraceFields,
  toPublicInlineTraceEvent,
} from '../inline-trace-response.js';

describe('inline trace response shaping', () => {
  it('removes internal tenant/project fields recursively', () => {
    const result = stripInternalInlineTraceFields({
      tenantId: 'tenant-1',
      tenant_id: 'tenant-1',
      projectId: 'project-1',
      project_id: 'project-1',
      message: 'visible',
      nested: {
        tenantId: 'tenant-2',
        project_id: 'project-2',
        value: 'kept',
      },
      list: [{ tenant_id: 'tenant-3', value: 'also-kept' }],
    });

    expect(result).toEqual({
      message: 'visible',
      nested: { value: 'kept' },
      list: [{ value: 'also-kept' }],
    });
  });

  it('returns only public inline trace fields', () => {
    expect(
      toPublicInlineTraceEvent({
        id: 'event-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        type: 'llm_call',
        timestamp: new Date('2026-05-14T00:00:00.000Z'),
        data: {
          model: 'model-1',
          tenantId: 'tenant-1',
          project_id: 'project-1',
        },
      }),
    ).toEqual({
      type: 'llm_call',
      data: { model: 'model-1' },
    });
  });
});
