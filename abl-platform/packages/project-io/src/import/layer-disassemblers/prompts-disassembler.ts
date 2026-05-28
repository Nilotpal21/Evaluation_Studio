import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import {
  buildMatchingSuperseded,
  buildRecord,
  buildSuperseded,
  buildSupersededByImportedValues,
  injectOwnership,
} from './disassembler-utils.js';
import { parsePromptLibraryBundleFile } from '../../prompt-library-io.js';

function existsInExisting(
  existing: Array<{ _id: string; [key: string]: unknown }> | undefined,
  recordId: string,
): boolean {
  if (!existing) {
    return false;
  }
  return existing.some((record) => String(record._id) === recordId);
}

export class PromptsDisassembler implements LayerDisassembler {
  readonly layer = 'prompts' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    const existingPromptItems = ctx.existingRecordIds?.get('prompt_library_items');
    const existingPromptVersions = ctx.existingRecordIds?.get('prompt_library_versions');

    for (const [filePath, content] of ctx.files) {
      const parsed = parsePromptLibraryBundleFile(filePath, content);
      if (!parsed.success) {
        warnings.push(parsed.error);
        continue;
      }

      if (
        ctx.conflictStrategy === 'skip' &&
        existsInExisting(existingPromptItems, parsed.data.promptId)
      ) {
        continue;
      }

      records.push(
        buildRecord(
          'prompts',
          'prompt_library_items',
          injectOwnership(
            {
              _id: parsed.data.promptId,
              name: parsed.data.name,
              description: parsed.data.description,
              tags: parsed.data.tags,
              status: parsed.data.status,
              nextVersionNumber: parsed.data.nextVersionNumber,
            },
            ctx,
          ),
        ),
      );

      for (const version of parsed.data.versions) {
        records.push(
          buildRecord(
            'prompts',
            'prompt_library_versions',
            injectOwnership(
              {
                _id: version.versionId,
                promptId: parsed.data.promptId,
                versionNumber: version.versionNumber,
                template: version.template,
                variables: version.variables,
                description: version.description,
                status: version.status,
                sourceHash: version.sourceHash,
                metadata: version.metadata,
                ...(version.publishedAt ? { publishedAt: new Date(version.publishedAt) } : {}),
              },
              ctx,
            ),
          ),
        );
      }
    }

    if (ctx.conflictStrategy === 'replace') {
      superseded.push(...buildSuperseded('prompts', 'prompt_library_items', existingPromptItems));
      superseded.push(
        ...buildSuperseded('prompts', 'prompt_library_versions', existingPromptVersions),
      );
    } else if (ctx.conflictStrategy === 'merge') {
      const importedPromptItems = records.filter(
        (record) => record.collection === 'prompt_library_items',
      );
      const matchingPromptItems = buildMatchingSuperseded(
        'prompts',
        'prompt_library_items',
        existingPromptItems,
        importedPromptItems,
        'name',
      );

      superseded.push(...matchingPromptItems);
      superseded.push(
        ...buildSupersededByImportedValues(
          'prompts',
          'prompt_library_versions',
          existingPromptVersions,
          'promptId',
          matchingPromptItems.map((record) => record.recordId),
        ),
      );
    }

    return { records, superseded, warnings };
  }
}
