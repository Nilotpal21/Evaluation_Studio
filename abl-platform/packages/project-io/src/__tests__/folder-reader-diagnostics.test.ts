import { describe, it, expect } from 'vitest';
import { readFolder, readFolderV2 } from '../import/folder-reader.js';

describe('readFolder JSON error diagnostics', () => {
  it('should include parse error detail for malformed project.json', () => {
    const files = new Map([
      ['project.json', '{ "name": "test", bad json here }'],
      ['agents/a.agent.abl', 'AGENT: A\n'],
    ]);
    const result = readFolder(files);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const jsonError = result.errors.find((e) => e.includes('project.json'));
    expect(jsonError).toBeDefined();
    expect(jsonError).toMatch(/Unexpected|token|position/i);
  });

  it('should include parse error detail for malformed abl.lock', () => {
    const files = new Map([
      ['abl.lock', 'not valid json'],
      ['agents/a.agent.abl', 'AGENT: A\n'],
    ]);
    const result = readFolder(files);
    const lockError = result.errors.find((e) => e.includes('abl.lock'));
    expect(lockError).toBeDefined();
    expect(lockError).toMatch(/Unexpected|token|position/i);
  });
});

describe('readFolderV2 JSON error diagnostics', () => {
  it('should include parse error detail for malformed project.json', () => {
    const files = new Map([
      ['project.json', '{ broken json'],
      ['agents/a.agent.abl', 'AGENT: A\n'],
    ]);
    const result = readFolderV2(files);
    const jsonError = result.errors.find((e) => e.includes('project.json'));
    expect(jsonError).toBeDefined();
    expect(jsonError).toMatch(/Unexpected|token|position/i);
  });

  it('should include parse error detail for malformed abl.lock in v2', () => {
    const files = new Map([
      ['abl.lock', '{ trailing comma, }'],
      ['agents/a.agent.abl', 'AGENT: A\n'],
    ]);
    const result = readFolderV2(files);
    const lockError = result.errors.find((e) => e.includes('abl.lock'));
    expect(lockError).toBeDefined();
    expect(lockError).toMatch(/Unexpected|token|position/i);
  });

  it('surfaces invalid locale root paths as explicit validation issues', () => {
    const files = new Map([
      ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
      ['agents/a.agent.abl', 'AGENT: A\n'],
      ['locales/messages.json', '{"conversation_complete":"Done"}'],
    ]);

    const result = readFolderV2(files);

    expect(result.success).toBe(false);
    expect(result.validationIssues).toEqual([
      expect.objectContaining({
        code: 'E_LOCALE_INVALID_PATH',
        path: 'locales/messages.json',
      }),
    ]);
    expect(result.errors.join(' ')).toContain('Expected locales/<locale>/<file>.json');
  });
});
