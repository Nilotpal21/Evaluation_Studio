import { describe, it, expect } from 'vitest';
import { _resolveSessionPlaceholdersForTest as resolve } from '../../platform/constructs/executors/mcp-tool-executor.js';

describe('MCP resolveSessionPlaceholders — _metadata dot-path', () => {
  const sessionVars = {
    id: 'sess-1',
    tenantId: 'tenant-1',
    _metadata: {
      sessionToken: 'ey-jwt-123',
      userProfile: { name: 'Alice', aboutMe: 'Engineer' },
      customData: { browserSid: 'br-456' },
      nullField: null,
    },
  };

  it('resolves top-level _metadata key', () => {
    expect(resolve('{{session._metadata.sessionToken}}', sessionVars)).toBe('ey-jwt-123');
  });

  it('resolves nested _metadata path', () => {
    expect(resolve('{{session._metadata.userProfile.name}}', sessionVars)).toBe('Alice');
  });

  it('resolves deeply nested path', () => {
    expect(resolve('{{session._metadata.customData.browserSid}}', sessionVars)).toBe('br-456');
  });

  it('returns empty string for missing nested path', () => {
    expect(resolve('{{session._metadata.nonexistent.deep}}', sessionVars)).toBe('');
  });

  it('resolves null to empty string (after null fix)', () => {
    expect(resolve('{{session._metadata.nullField}}', sessionVars)).toBe('');
  });

  it('resolves multiple placeholders in one string', () => {
    const result = resolve(
      'Bearer {{session._metadata.sessionToken}} for {{session._metadata.userProfile.name}}',
      sessionVars,
    );
    expect(result).toBe('Bearer ey-jwt-123 for Alice');
  });

  it('preserves non-session placeholders', () => {
    expect(resolve('{{secrets.API_KEY}} {{session._metadata.sessionToken}}', sessionVars)).toBe(
      '{{secrets.API_KEY}} ey-jwt-123',
    );
  });

  it('works with existing flat session keys', () => {
    expect(resolve('{{session.tenantId}}', sessionVars)).toBe('tenant-1');
  });

  it('blocks __proto__ traversal (prototype pollution)', () => {
    expect(resolve('{{session.__proto__.polluted}}', sessionVars)).toBe('');
  });

  it('blocks constructor traversal (prototype pollution)', () => {
    expect(resolve('{{session.constructor.name}}', sessionVars)).toBe('');
  });

  it('blocks prototype traversal in nested path', () => {
    expect(resolve('{{session._metadata.prototype.exploit}}', sessionVars)).toBe('');
  });
});
