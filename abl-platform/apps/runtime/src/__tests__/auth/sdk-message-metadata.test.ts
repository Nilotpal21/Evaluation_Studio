import { describe, expect, test } from 'vitest';
import {
  cloneSdkMessageMetadata,
  normalizeSdkMessageMetadata,
} from '../../services/identity/sdk-message-metadata.js';

describe('sdk-message-metadata validation', () => {
  test('preserves nested JSON-like metadata', () => {
    const metadata = {
      locale: 'en-US',
      flags: ['priority', 'vip'],
      context: {
        plan: 'enterprise',
        seats: 25,
      },
    };

    expect(normalizeSdkMessageMetadata(metadata)).toEqual({
      success: true,
      data: metadata,
    });
    expect(cloneSdkMessageMetadata(metadata)).toEqual(metadata);
  });

  test('rejects non-object top-level metadata', () => {
    const result = normalizeSdkMessageMetadata(['invalid']);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_MESSAGE_METADATA');
      expect(result.error.issues).toContain('metadata must be an object');
    }
  });

  test('rejects nested objects deeper than the SDK limit', () => {
    const result = normalizeSdkMessageMetadata({
      level1: {
        level2: {
          level3: 'too-deep',
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toContain('exceeds max depth');
    }
  });
});
