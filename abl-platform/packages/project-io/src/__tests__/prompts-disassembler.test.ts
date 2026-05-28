import { describe, expect, it } from 'vitest';
import { PromptsDisassembler } from '../import/layer-disassemblers/prompts-disassembler.js';

describe('PromptsDisassembler', () => {
  it('converts prompt bundle files into prompt item and version staged records', async () => {
    const disassembler = new PromptsDisassembler();

    const result = await disassembler.disassemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      conflictStrategy: 'replace',
      files: new Map([
        [
          'prompts/support_prompt.prompt.json',
          JSON.stringify({
            promptId: 'pl_prompt_1',
            name: 'Support Prompt',
            description: 'Shared support prompt',
            tags: ['support'],
            status: 'active',
            nextVersionNumber: 2,
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
              },
            ],
          }),
        ],
      ]),
      existingRecordIds: new Map([
        ['prompt_library_items', [{ _id: 'existing-prompt' }]],
        ['prompt_library_versions', [{ _id: 'existing-version' }]],
      ]),
    });

    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'prompts',
          collection: 'prompt_library_items',
          data: expect.objectContaining({
            _id: 'pl_prompt_1',
            name: 'Support Prompt',
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            createdBy: 'user-1',
          }),
        }),
        expect.objectContaining({
          layer: 'prompts',
          collection: 'prompt_library_versions',
          data: expect.objectContaining({
            _id: 'plv_prompt_1_v1',
            promptId: 'pl_prompt_1',
            versionNumber: 1,
            template: 'Hello {{name}}',
            status: 'active',
            sourceHash: 'hash-v1',
            publishedAt: new Date('2026-05-03T00:00:00.000Z'),
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            createdBy: 'user-1',
          }),
        }),
      ]),
    );
    expect(result.superseded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'prompts',
          collection: 'prompt_library_items',
          recordId: 'existing-prompt',
        }),
        expect.objectContaining({
          layer: 'prompts',
          collection: 'prompt_library_versions',
          recordId: 'existing-version',
        }),
      ]),
    );
    expect(result.warnings).toEqual([]);
  });
});
