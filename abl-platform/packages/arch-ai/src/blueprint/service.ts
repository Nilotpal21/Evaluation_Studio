import type { BlueprintV2Output } from './v2-schema.js';
import { assertValidBlueprintV2Output } from './v2-schema.js';

export interface BlueprintLookup {
  tenantId: string;
  projectId?: string | null;
  sessionId?: string | null;
}

export interface CreateBlueprintInput extends BlueprintLookup {
  output: BlueprintV2Output;
  state?: 'draft' | 'locked' | 'linked' | 'archived';
  version?: number;
  createdBy: string;
  sectionStatus?: Record<string, unknown> | null;
}

export interface BlueprintEditInput extends BlueprintLookup {
  sectionId: string;
  changes: unknown;
  updatedBy: string;
}

function normalizeDoc(doc: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function buildLookupFilter(input: BlueprintLookup): Record<string, unknown> {
  const filter: Record<string, unknown> = { tenantId: input.tenantId };
  if (input.projectId) {
    filter.projectId = input.projectId;
  } else if (input.sessionId) {
    filter.sessionId = input.sessionId;
  } else {
    throw new Error('Blueprint lookup requires projectId or sessionId');
  }
  return filter;
}

export class BlueprintService {
  static async getLatest(input: BlueprintLookup): Promise<Record<string, unknown> | null> {
    const { ArchBlueprint } = await import('@agent-platform/database/models');
    const doc = await ArchBlueprint.findOne(buildLookupFilter(input)).sort({ version: -1 }).lean();
    return normalizeDoc(doc as Record<string, unknown> | null);
  }

  static async create(input: CreateBlueprintInput): Promise<Record<string, unknown>> {
    const { ArchBlueprint } = await import('@agent-platform/database/models');
    const output = assertValidBlueprintV2Output(input.output);
    const version =
      input.version ??
      ((await ArchBlueprint.findOne(buildLookupFilter(input)).sort({ version: -1 }).lean())
        ?.version ?? 0) + 1;

    const doc = await ArchBlueprint.create({
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      version,
      state: input.state ?? 'draft',
      output,
      sectionStatus: input.sectionStatus ?? null,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      lockedAt: input.state === 'locked' || input.state === 'linked' ? new Date() : null,
      lockedBy: input.state === 'locked' || input.state === 'linked' ? input.createdBy : null,
    });
    return normalizeDoc(doc.toObject())!;
  }

  static async forkDraft(
    input: BlueprintLookup & { userId: string },
  ): Promise<Record<string, unknown>> {
    const latest = await BlueprintService.getLatest(input);
    if (!latest) {
      throw new Error('No blueprint exists to fork');
    }
    return BlueprintService.create({
      ...input,
      output: latest.output as BlueprintV2Output,
      state: 'draft',
      createdBy: input.userId,
    });
  }

  static async lockLatest(
    input: BlueprintLookup & { userId: string },
  ): Promise<Record<string, unknown>> {
    const { ArchBlueprint } = await import('@agent-platform/database/models');
    const latest = await ArchBlueprint.findOne({
      ...buildLookupFilter(input),
      state: 'draft',
    })
      .sort({ version: -1 })
      .lean();
    if (!latest) {
      throw new Error('No draft blueprint exists to lock');
    }
    assertValidBlueprintV2Output(latest.output);
    const doc = await ArchBlueprint.findOneAndUpdate(
      { _id: latest._id, tenantId: input.tenantId },
      {
        $set: {
          state: input.projectId ? 'linked' : 'locked',
          lockedAt: new Date(),
          lockedBy: input.userId,
          updatedBy: input.userId,
        },
      },
      { new: true },
    ).lean();
    return normalizeDoc(doc as Record<string, unknown> | null)!;
  }

  static async appendEdit(input: BlueprintEditInput): Promise<Record<string, unknown>> {
    const { ArchBlueprint } = await import('@agent-platform/database/models');
    const latest = await ArchBlueprint.findOne({
      ...buildLookupFilter(input),
      state: 'draft',
    }).sort({ version: -1 });
    if (!latest) {
      throw new Error('No draft blueprint exists for editing');
    }

    const sectionStatus = {
      ...((latest.sectionStatus as Record<string, unknown> | null) ?? {}),
      [input.sectionId]: {
        status: 'edited',
        updatedAt: new Date().toISOString(),
        updatedBy: input.updatedBy,
        changes: input.changes,
      },
    };

    latest.sectionStatus = sectionStatus;
    latest.updatedBy = input.updatedBy;
    await latest.save();
    return normalizeDoc(latest.toObject())!;
  }
}
