import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectRejectedMessage } from '../helpers/expect-rejected-message';
import { getDocsConfig } from '../../lib/docs/config';

// Mock fs.promises since config.ts uses filesystem I/O
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: mockReadFile,
    },
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: mockReadFile,
      },
    },
  };
});

import { promises as fs } from 'fs';
const mockedReadFile = vi.mocked(fs.readFile);

describe('getDocsConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses valid config JSON', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        siteName: 'Test Docs',
        sections: [{ slug: 'intro', title: 'Introduction' }],
      }),
    );

    const config = await getDocsConfig();
    expect(config.siteName).toBe('Test Docs');
    expect(config.sections).toHaveLength(1);
    expect(config.sections[0]).toEqual({
      slug: 'intro',
      title: 'Introduction',
    });
  });

  it('returns defaults for missing fields', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({}));

    const config = await getDocsConfig();
    expect(config.siteName).toBe('Internal Docs');
    expect(config.sections).toEqual([]);
  });

  it('returns empty sections for non-array sections', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ siteName: 'Test', sections: 'not-array' }));

    const config = await getDocsConfig();
    expect(config.sections).toEqual([]);
  });

  it('throws on invalid JSON', async () => {
    mockedReadFile.mockResolvedValue('not json');
    await expect(getDocsConfig()).rejects.toThrow();
  });

  it('throws when file not found', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
    await expectRejectedMessage(getDocsConfig(), 'ENOENT');
  });
});
