import { describe, expect, it } from 'vitest';
import {
  isPromptBundleFilePath,
  parsePromptLibraryBundleFile,
  promptBundleFilePath,
  serializePromptLibraryBundleForFile,
} from '../prompt-library-io.js';

describe('prompt library IO', () => {
  it('builds canonical prompt bundle file paths', () => {
    expect(promptBundleFilePath('Support Prompt')).toBe('prompts/support_prompt.prompt.json');
    expect(isPromptBundleFilePath('prompts/support_prompt.prompt.json')).toBe(true);
    expect(isPromptBundleFilePath('prompts/support_prompt/version-1.json')).toBe(false);
  });

  it('round-trips prompt bundles with preserved prompt and version ids', () => {
    const content = serializePromptLibraryBundleForFile({
      promptId: 'pl_prompt_1',
      name: 'Support Prompt',
      description: 'Shared support assistant prompt',
      tags: ['support', 'voice'],
      status: 'active',
      nextVersionNumber: 3,
      versions: [
        {
          versionId: 'plv_prompt_1_v1',
          versionNumber: 1,
          template: 'Hello {{name}}',
          variables: ['name'],
          description: 'Initial prompt',
          status: 'active',
          sourceHash: 'hash-v1',
          publishedAt: '2026-05-03T00:00:00.000Z',
          metadata: { locale: 'en' },
        },
        {
          versionId: 'plv_prompt_1_v2',
          versionNumber: 2,
          template: 'Hello again {{name}}',
          variables: ['name'],
          description: 'Follow-up prompt',
          status: 'draft',
          sourceHash: 'hash-v2',
        },
      ],
    });

    const parsed = parsePromptLibraryBundleFile('prompts/support_prompt.prompt.json', content);

    expect(parsed).toEqual({
      success: true,
      data: {
        promptId: 'pl_prompt_1',
        name: 'Support Prompt',
        description: 'Shared support assistant prompt',
        tags: ['support', 'voice'],
        status: 'active',
        nextVersionNumber: 3,
        versions: [
          {
            versionId: 'plv_prompt_1_v1',
            versionNumber: 1,
            template: 'Hello {{name}}',
            variables: ['name'],
            description: 'Initial prompt',
            status: 'active',
            sourceHash: 'hash-v1',
            publishedAt: '2026-05-03T00:00:00.000Z',
            metadata: { locale: 'en' },
          },
          {
            versionId: 'plv_prompt_1_v2',
            versionNumber: 2,
            template: 'Hello again {{name}}',
            variables: ['name'],
            description: 'Follow-up prompt',
            status: 'draft',
            sourceHash: 'hash-v2',
          },
        ],
      },
    });
  });
});
