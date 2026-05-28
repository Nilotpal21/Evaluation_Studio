import { describe, expect, it } from 'vitest';
import { deriveStudioUrl } from '../utils/studio-api.js';

describe('deriveStudioUrl', () => {
  it('keeps remote deployments on the connected origin', () => {
    expect(deriveStudioUrl('https://agents-dev.kore.ai')).toBe('https://agents-dev.kore.ai');
  });

  it('does not rewrite explicit remote ports to the local Studio port', () => {
    expect(deriveStudioUrl('https://agents-dev.kore.ai:8443')).toBe(
      'https://agents-dev.kore.ai:8443',
    );
  });

  it('rewrites explicit local runtime ports to the local Studio port', () => {
    expect(deriveStudioUrl('http://localhost:3112')).toBe('http://localhost:5173');
    expect(deriveStudioUrl('http://127.0.0.1:3112')).toBe('http://127.0.0.1:5173');
  });

  it('returns unparsable URLs unchanged', () => {
    expect(deriveStudioUrl('not a url')).toBe('not a url');
  });
});
