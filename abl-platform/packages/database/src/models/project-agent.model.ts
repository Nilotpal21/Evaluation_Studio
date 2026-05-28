/**
 * Project Agent Model
 *
 * Stores agent definitions within a project.
 * Each agent has a name, DSL content, and active version info.
 */

import mongoose, { Schema, model } from 'mongoose';
import { buildProjectAgentPath, validateAgentName } from '@agent-platform/shared-kernel';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectAgent {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  agentPath: string;
  description: string | null;
  dslContent: string | null;
  activeVersions: any;
  ownerId: string | null;
  ownerTeamId: string | null;
  sourceHash: string | null;
  lastEditedBy: string | null;
  lastEditedAt: Date | null;
  dslValidationStatus?: 'valid' | 'warning' | 'error' | null;
  dslDiagnostics?: Array<{
    severity: 'error' | 'warning';
    message: string;
    source?: string;
  }>;
  systemPromptLibraryRef?: { promptId: string; versionId: string };
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectAgentSchema = new Schema<IProjectAgent>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: {
      type: String,
      required: true,
      validate: {
        validator: (value: string) => validateAgentName(value) === null,
        message: (props: { value: string }) =>
          validateAgentName(props.value) ?? 'Invalid agent name',
      },
    },
    agentPath: { type: String, required: true },
    description: { type: String, default: null },
    dslContent: { type: String, default: null },
    activeVersions: { type: Schema.Types.Mixed, default: null },
    ownerId: { type: String, default: null },
    ownerTeamId: { type: String, default: null },
    sourceHash: { type: String, default: null },
    lastEditedBy: { type: String, default: null },
    lastEditedAt: { type: Date, default: null },
    dslValidationStatus: {
      type: String,
      enum: ['valid', 'warning', 'error'],
      default: null,
    },
    dslDiagnostics: {
      type: [
        {
          severity: { type: String, enum: ['error', 'warning'], required: true },
          message: { type: String, required: true },
          source: { type: String, default: null },
        },
      ],
      default: [],
    },
    systemPromptLibraryRef: { type: Schema.Types.Mixed, required: false, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_agents' },
);

// ─── Canonical Identity Guards ──────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function assertValidProjectAgentName(name: string): void {
  const nameError = validateAgentName(name);
  if (nameError) {
    throw new Error(nameError);
  }
}

function canonicalizeProjectAgentDocument(doc: IProjectAgent): void {
  if (typeof doc.projectId !== 'string' || typeof doc.name !== 'string') {
    return;
  }

  doc.projectId = doc.projectId.trim();
  doc.name = doc.name.trim();
  assertValidProjectAgentName(doc.name);
  doc.agentPath = buildProjectAgentPath(doc.projectId, doc.name);
}

function canonicalizeProjectAgentRecord(record: Record<string, unknown>): void {
  const projectId = readStringField(record, 'projectId')?.trim();
  const name = readStringField(record, 'name')?.trim();
  if (!projectId || !name) {
    return;
  }

  assertValidProjectAgentName(name);
  record.projectId = projectId;
  record.name = name;
  record.agentPath = buildProjectAgentPath(projectId, name);
}

async function canonicalizeProjectAgentQueryUpdate(
  query: mongoose.Query<unknown, unknown>,
): Promise<void> {
  const update = query.getUpdate();
  if (!isRecord(update)) {
    return;
  }

  const setUpdate = isRecord(update.$set) ? update.$set : {};
  const hasIdentityUpdate =
    hasOwn(update, 'projectId') ||
    hasOwn(update, 'name') ||
    hasOwn(update, 'agentPath') ||
    hasOwn(setUpdate, 'projectId') ||
    hasOwn(setUpdate, 'name') ||
    hasOwn(setUpdate, 'agentPath');

  if (!hasIdentityUpdate) {
    return;
  }

  let projectId = readStringField(update, 'projectId') ?? readStringField(setUpdate, 'projectId');
  let name = readStringField(update, 'name') ?? readStringField(setUpdate, 'name');

  if (!projectId || !name) {
    const current = (await query.model
      .findOne(query.getQuery(), { projectId: 1, name: 1 })
      .lean()) as { projectId?: string; name?: string } | null;
    projectId ??= current?.projectId;
    name ??= current?.name;
  }

  if (!projectId || !name) {
    return;
  }

  assertValidProjectAgentName(name);

  const nextSet = isRecord(update.$set) ? update.$set : {};
  nextSet.agentPath = buildProjectAgentPath(projectId, name);
  update.$set = nextSet;
  delete update.agentPath;
  query.setUpdate(update);
}

function canonicalizeProjectAgentBulkUpdate(operation: Record<string, unknown>): void {
  const write = ['updateOne', 'updateMany'].find((key) => isRecord(operation[key]));
  if (!write) {
    if (isRecord(operation.insertOne) && isRecord(operation.insertOne.document)) {
      canonicalizeProjectAgentRecord(operation.insertOne.document);
    }
    if (isRecord(operation.replaceOne) && isRecord(operation.replaceOne.replacement)) {
      canonicalizeProjectAgentRecord(operation.replaceOne.replacement);
    }
    return;
  }

  const spec = operation[write];
  if (!isRecord(spec) || !isRecord(spec.update)) {
    return;
  }

  const update = spec.update;
  const setUpdate = isRecord(update.$set) ? update.$set : {};
  const hasIdentityUpdate =
    hasOwn(update, 'projectId') ||
    hasOwn(update, 'name') ||
    hasOwn(update, 'agentPath') ||
    hasOwn(setUpdate, 'projectId') ||
    hasOwn(setUpdate, 'name') ||
    hasOwn(setUpdate, 'agentPath');

  if (!hasIdentityUpdate) {
    return;
  }

  const filter = isRecord(spec.filter) ? spec.filter : {};
  const projectId =
    readStringField(update, 'projectId') ??
    readStringField(setUpdate, 'projectId') ??
    readStringField(filter, 'projectId');
  const name = readStringField(update, 'name') ?? readStringField(setUpdate, 'name');

  if (!name) {
    throw new Error('ProjectAgent bulk identity updates must include name');
  }

  assertValidProjectAgentName(name);

  if (!projectId) {
    throw new Error('ProjectAgent bulk identity updates must include projectId');
  }

  const nextSet = isRecord(update.$set) ? update.$set : {};
  nextSet.agentPath = buildProjectAgentPath(projectId, name);
  update.$set = nextSet;
  delete update.agentPath;
}

ProjectAgentSchema.pre('validate', function () {
  canonicalizeProjectAgentDocument(this);
});

ProjectAgentSchema.pre('insertMany', function (next, docs: IProjectAgent[]) {
  for (const doc of docs) {
    canonicalizeProjectAgentDocument(doc);
  }
  next();
});

ProjectAgentSchema.pre('findOneAndUpdate', async function () {
  await canonicalizeProjectAgentQueryUpdate(this);
});

ProjectAgentSchema.pre('updateOne', async function () {
  await canonicalizeProjectAgentQueryUpdate(this);
});

ProjectAgentSchema.pre('bulkWrite', function (next, operations: unknown[]) {
  for (const operation of operations) {
    if (isRecord(operation)) {
      canonicalizeProjectAgentBulkUpdate(operation);
    }
  }
  next();
});

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectAgentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectAgentSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
ProjectAgentSchema.index({ tenantId: 1, projectId: 1 });
ProjectAgentSchema.index({ tenantId: 1, projectId: 1, agentPath: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectAgent =
  (mongoose.models.ProjectAgent as any) || model<IProjectAgent>('ProjectAgent', ProjectAgentSchema);
