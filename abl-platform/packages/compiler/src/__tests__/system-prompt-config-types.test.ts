import { describe, test, expect } from 'vitest';
import type { SystemPromptConfig } from '../platform/ir/schema.js';

describe('SystemPromptConfig libraryRef type', () => {
  test('accepts config with libraryRef', () => {
    const withRef: SystemPromptConfig = {
      template: 'Hello',
      sections: {},
      libraryRef: { promptId: 'pl_123', versionId: 'plv_456', resolvedHash: 'abc' },
    };
    // Verify the object is structurally valid at runtime
    expect(withRef.libraryRef).toBeDefined();
    expect(withRef.libraryRef!.promptId).toBe('pl_123');
  });

  test('accepts config without libraryRef', () => {
    const withoutRef: SystemPromptConfig = {
      template: 'Hello',
      sections: {},
    };
    expect(withoutRef.libraryRef).toBeUndefined();
  });
});
