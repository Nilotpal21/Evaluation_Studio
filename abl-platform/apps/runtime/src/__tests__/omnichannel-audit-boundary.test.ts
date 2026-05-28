import { afterEach, describe, expect, test } from 'vitest';

import {
  clearAuditBufferForTesting,
  emitOmnichannelAudit,
  OMNICHANNEL_AUDIT_CLASSIFICATION,
  queryAuditEvents,
} from '../services/omnichannel/omnichannel-audit.js';

describe('omnichannel audit boundary', () => {
  afterEach(() => {
    delete process.env.AUDIT_PIPELINE_TEST_BACKEND;
    clearAuditBufferForTesting();
  });

  test('is explicitly classified as operational-only', () => {
    expect(OMNICHANNEL_AUDIT_CLASSIFICATION).toBe('operational_only');
  });

  test('remains tenant/project scoped and memory bounded', async () => {
    process.env.AUDIT_PIPELINE_TEST_BACKEND = 'memory';

    for (let index = 0; index < 1005; index += 1) {
      emitOmnichannelAudit({
        eventType: 'typed_input_interrupted_tts',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: `session-${index}`,
        data: { index },
      });
    }

    emitOmnichannelAudit({
      eventType: 'consent_granted',
      tenantId: 'tenant-2',
      projectId: 'project-2',
      sessionId: 'other-session',
    });

    const tenantProjectEntries = await queryAuditEvents('tenant-1', 'project-1', 2000);
    const otherEntries = await queryAuditEvents('tenant-2', 'project-2', 2000);

    expect(tenantProjectEntries).toHaveLength(999);
    expect(tenantProjectEntries.at(-1)?.sessionId).toBe('session-6');
    expect(tenantProjectEntries[0]?.sessionId).toBe('session-1004');
    expect(otherEntries).toHaveLength(1);
    expect(otherEntries[0]?.sessionId).toBe('other-session');
  });
});
