import { describe, expect, it } from 'vitest';
import { PIIPattern } from '../models/pii-pattern.model.js';

describe('PIIPattern model', () => {
  it('preserves the validate payload field while suppressing reserved-key warning noise', () => {
    expect((PIIPattern.schema as any).options.suppressReservedKeysWarning).toBe(true);
    expect(PIIPattern.schema.path('validate')).toBeDefined();

    const doc = new PIIPattern({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'phone-validator',
      piiType: 'phone',
      regex: '\\\\d+',
      validate: '^\\\\d{10,}$',
      redaction: { type: 'predefined', label: '[PHONE]' },
      consumerAccess: [],
      defaultRenderMode: 'redacted',
      createdBy: 'user-1',
    });

    expect(doc.toObject().validate).toBe('^\\\\d{10,}$');
  });
});
