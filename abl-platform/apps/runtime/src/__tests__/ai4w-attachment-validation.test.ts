/**
 * AI4W Attachment Validation Unit Tests
 *
 * Tests file validation logic (size, MIME type) without mocking internal components.
 * These are pure function tests that can run without external dependencies.
 */

import { describe, test, expect } from 'vitest';
import type { AttachmentConfig } from '@agent-platform/shared';

// Pure validation functions extracted for testing
function validateFileSize(fileSizeBytes: number, maxSizeBytes: number): boolean {
  return fileSizeBytes <= maxSizeBytes;
}

function validateMimeType(mimeType: string, allowedMimeTypes: string[]): boolean {
  if (allowedMimeTypes.length === 0) {
    return true; // Empty list = allow all
  }
  return allowedMimeTypes.includes(mimeType);
}

const DEFAULT_CONFIG: AttachmentConfig = {
  enabled: true,
  maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  maxAttachmentsPerMessage: 10,
  maxAttachmentsPerSession: 100,
  maxTotalStorageBytesPerTenant: 10 * 1024 * 1024 * 1024,
  allowedCategories: ['image', 'document', 'audio', 'video'],
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'application/pdf',
    'text/plain',
    'audio/mpeg',
    'video/mp4',
  ],
  retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
  quotas: { maxUploadsPerMinute: 60, maxConcurrentProcessingJobs: 10 },
};

describe('AI4W Attachment Validation - File Size', () => {
  const maxSize = DEFAULT_CONFIG.maxFileSizeBytes;

  test('accepts file smaller than limit', () => {
    expect(validateFileSize(1024, maxSize)).toBe(true);
    expect(validateFileSize(1 * 1024 * 1024, maxSize)).toBe(true);
    expect(validateFileSize(5 * 1024 * 1024, maxSize)).toBe(true);
  });

  test('accepts file exactly at limit (boundary)', () => {
    expect(validateFileSize(10 * 1024 * 1024, maxSize)).toBe(true);
  });

  test('rejects file one byte over limit (boundary)', () => {
    expect(validateFileSize(10 * 1024 * 1024 + 1, maxSize)).toBe(false);
  });

  test('rejects file significantly over limit', () => {
    expect(validateFileSize(11 * 1024 * 1024, maxSize)).toBe(false);
    expect(validateFileSize(20 * 1024 * 1024, maxSize)).toBe(false);
    expect(validateFileSize(100 * 1024 * 1024, maxSize)).toBe(false);
  });

  test('accepts zero-byte file', () => {
    expect(validateFileSize(0, maxSize)).toBe(true);
  });

  test('accepts one-byte file', () => {
    expect(validateFileSize(1, maxSize)).toBe(true);
  });
});

describe('AI4W Attachment Validation - MIME Type', () => {
  const allowedTypes = DEFAULT_CONFIG.allowedMimeTypes;

  test('accepts allowed image types', () => {
    expect(validateMimeType('image/png', allowedTypes)).toBe(true);
    expect(validateMimeType('image/jpeg', allowedTypes)).toBe(true);
  });

  test('accepts allowed document types', () => {
    expect(validateMimeType('application/pdf', allowedTypes)).toBe(true);
    expect(validateMimeType('text/plain', allowedTypes)).toBe(true);
  });

  test('accepts allowed media types', () => {
    expect(validateMimeType('audio/mpeg', allowedTypes)).toBe(true);
    expect(validateMimeType('video/mp4', allowedTypes)).toBe(true);
  });

  test('rejects disallowed types', () => {
    expect(validateMimeType('application/x-msdownload', allowedTypes)).toBe(false);
    expect(validateMimeType('application/x-executable', allowedTypes)).toBe(false);
    expect(validateMimeType('text/html', allowedTypes)).toBe(false);
    expect(validateMimeType('application/javascript', allowedTypes)).toBe(false);
  });

  test('rejects unknown/custom MIME types', () => {
    expect(validateMimeType('application/x-custom', allowedTypes)).toBe(false);
    expect(validateMimeType('foo/bar', allowedTypes)).toBe(false);
  });

  test('is case sensitive (matches exact casing)', () => {
    expect(validateMimeType('image/PNG', allowedTypes)).toBe(false);
    expect(validateMimeType('IMAGE/PNG', allowedTypes)).toBe(false);
  });

  test('allows all types when allowedMimeTypes is empty', () => {
    const emptyList: string[] = [];
    expect(validateMimeType('image/png', emptyList)).toBe(true);
    expect(validateMimeType('application/x-custom', emptyList)).toBe(true);
    expect(validateMimeType('foo/bar', emptyList)).toBe(true);
  });
});

describe('AI4W Attachment Validation - Combined Rules', () => {
  test('file must pass both size and type checks', () => {
    const maxSize = DEFAULT_CONFIG.maxFileSizeBytes;
    const allowedTypes = DEFAULT_CONFIG.allowedMimeTypes;

    // Valid size + valid type = accept
    const case1 = {
      size: 1024,
      type: 'image/png',
      expectedSizeCheck: true,
      expectedTypeCheck: true,
    };
    expect(validateFileSize(case1.size, maxSize)).toBe(case1.expectedSizeCheck);
    expect(validateMimeType(case1.type, allowedTypes)).toBe(case1.expectedTypeCheck);

    // Valid size + invalid type = reject
    const case2 = {
      size: 1024,
      type: 'application/x-executable',
      expectedSizeCheck: true,
      expectedTypeCheck: false,
    };
    expect(validateFileSize(case2.size, maxSize)).toBe(case2.expectedSizeCheck);
    expect(validateMimeType(case2.type, allowedTypes)).toBe(case2.expectedTypeCheck);

    // Invalid size + valid type = reject
    const case3 = {
      size: 11 * 1024 * 1024,
      type: 'image/png',
      expectedSizeCheck: false,
      expectedTypeCheck: true,
    };
    expect(validateFileSize(case3.size, maxSize)).toBe(case3.expectedSizeCheck);
    expect(validateMimeType(case3.type, allowedTypes)).toBe(case3.expectedTypeCheck);

    // Invalid size + invalid type = reject
    const case4 = {
      size: 11 * 1024 * 1024,
      type: 'application/x-executable',
      expectedSizeCheck: false,
      expectedTypeCheck: false,
    };
    expect(validateFileSize(case4.size, maxSize)).toBe(case4.expectedSizeCheck);
    expect(validateMimeType(case4.type, allowedTypes)).toBe(case4.expectedTypeCheck);
  });
});

describe('AI4W Attachment Validation - Edge Cases', () => {
  test('handles negative file size', () => {
    expect(validateFileSize(-1, 10 * 1024 * 1024)).toBe(true); // -1 <= maxSize
  });

  test('handles empty MIME type string', () => {
    expect(validateMimeType('', DEFAULT_CONFIG.allowedMimeTypes)).toBe(false);
  });

  test('handles whitespace in MIME type', () => {
    expect(validateMimeType(' image/png', DEFAULT_CONFIG.allowedMimeTypes)).toBe(false);
    expect(validateMimeType('image/png ', DEFAULT_CONFIG.allowedMimeTypes)).toBe(false);
  });

  test('does not accept partial MIME type matches', () => {
    expect(validateMimeType('image', DEFAULT_CONFIG.allowedMimeTypes)).toBe(false);
    expect(validateMimeType('png', DEFAULT_CONFIG.allowedMimeTypes)).toBe(false);
  });
});

describe('AI4W Attachment Config - Limits', () => {
  test('10MB limit matches expected bytes', () => {
    expect(DEFAULT_CONFIG.maxFileSizeBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_CONFIG.maxFileSizeBytes).toBe(10485760);
  });

  test('max attachments per message is 10', () => {
    expect(DEFAULT_CONFIG.maxAttachmentsPerMessage).toBe(10);
  });

  test('max attachments per session is 100', () => {
    expect(DEFAULT_CONFIG.maxAttachmentsPerSession).toBe(100);
  });

  test('supports expected MIME types for AI4W', () => {
    const config = DEFAULT_CONFIG;
    const expectedTypes = [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'text/plain',
      'audio/mpeg',
      'video/mp4',
    ];

    for (const type of expectedTypes) {
      expect(config.allowedMimeTypes).toContain(type);
    }
  });
});
