import { PromptLibraryItem, PromptLibraryVersion } from '@agent-platform/database/models';
import type { LayerAssemblyResult } from '../../types.js';
import { assignCollisionSafePath } from '../folder-builder.js';
import {
  promptBundleFilePath,
  serializePromptLibraryBundleForFile,
} from '../../prompt-library-io.js';
import type { LayerAssembler, LayerQueryContext } from './types.js';

export class PromptsAssembler implements LayerAssembler {
  readonly layer = 'prompts' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const files = new Map<string, string>();
    const [items, versions] = await Promise.all([
      PromptLibraryItem.find({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }).lean() as Promise<
        Array<{
          _id: string;
          name: string;
          description?: string;
          tags?: string[];
          status: 'active' | 'archived';
          nextVersionNumber?: number;
        }>
      >,
      PromptLibraryVersion.find({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      })
        .sort({ versionNumber: 1 })
        .lean() as Promise<
        Array<{
          _id: string;
          promptId: string;
          versionNumber: number;
          template: string;
          variables?: string[];
          description?: string;
          status: 'draft' | 'active' | 'archived';
          sourceHash: string;
          publishedAt?: Date | null;
          metadata?: Record<string, unknown> | null;
        }>
      >,
    ]);

    const versionsByPromptId = new Map<
      string,
      Array<{
        _id: string;
        versionNumber: number;
        template: string;
        variables?: string[];
        description?: string;
        status: 'draft' | 'active' | 'archived';
        sourceHash: string;
        publishedAt?: Date | null;
        metadata?: Record<string, unknown> | null;
      }>
    >();

    for (const version of versions) {
      versionsByPromptId.set(version.promptId, [
        ...(versionsByPromptId.get(version.promptId) ?? []),
        version,
      ]);
    }

    for (const item of items) {
      const path = assignCollisionSafePath(promptBundleFilePath(item.name), files);
      files.set(
        path,
        serializePromptLibraryBundleForFile({
          promptId: String(item._id),
          name: item.name,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          tags: item.tags ?? [],
          status: item.status,
          nextVersionNumber: item.nextVersionNumber ?? 0,
          versions: (versionsByPromptId.get(String(item._id)) ?? []).map((version) => ({
            versionId: String(version._id),
            versionNumber: version.versionNumber,
            template: version.template,
            variables: version.variables ?? [],
            ...(typeof version.description === 'string'
              ? { description: version.description }
              : {}),
            status: version.status,
            sourceHash: version.sourceHash,
            ...(version.publishedAt ? { publishedAt: version.publishedAt.toISOString() } : {}),
            ...(version.metadata && typeof version.metadata === 'object'
              ? { metadata: version.metadata }
              : {}),
          })),
        }),
      );
    }

    return {
      layer: this.layer,
      files,
      entityCount: items.length,
      warnings: [],
    };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    return PromptLibraryItem.countDocuments({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
    });
  }
}
