/**
 * Project Member Model
 *
 * Stores membership relationships between users and projects.
 * Each member has a role and optionally a custom role reference.
 */

import mongoose, { Schema, model } from 'mongoose';
import { PROJECT_ROLE_NAMES, type ProjectRoleName } from '@agent-platform/shared-auth';
import { uuidv7 } from '../mongo/base-document.js';

export type ProjectMemberRole = ProjectRoleName | 'custom';
const PROJECT_MEMBER_ROLE_NAMES = [...PROJECT_ROLE_NAMES, 'custom'] as const;
const CUSTOM_ROLE_REQUIRED_MESSAGE = 'customRoleId is required when role is "custom"';
const CUSTOM_ROLE_FORBIDDEN_MESSAGE = 'customRoleId must be null unless role is "custom"';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectMember {
  _id: string;
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  customRoleId: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectMemberSchema = new Schema<IProjectMember>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    userId: { type: String, required: true },
    role: { type: String, required: true, enum: PROJECT_MEMBER_ROLE_NAMES },
    customRoleId: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_members' },
);

// ─── Guards ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

ProjectMemberSchema.pre('validate', function () {
  if (this.role === 'custom') {
    if (typeof this.customRoleId !== 'string' || this.customRoleId.trim().length === 0) {
      this.invalidate('customRoleId', CUSTOM_ROLE_REQUIRED_MESSAGE);
    }
    return;
  }

  if (this.customRoleId !== null) {
    this.invalidate('customRoleId', CUSTOM_ROLE_FORBIDDEN_MESSAGE);
  }
});

ProjectMemberSchema.pre('findOneAndUpdate', async function () {
  const update = this.getUpdate();
  if (!isRecord(update)) {
    return;
  }

  const setUpdate = isRecord(update.$set) ? update.$set : null;
  const unsetUpdate = isRecord(update.$unset) ? update.$unset : null;
  const current = await this.model.findOne(this.getQuery(), { role: 1, customRoleId: 1 }).lean();
  if (!current) {
    return;
  }

  const hasRoleUpdate = (setUpdate && hasOwn(setUpdate, 'role')) || hasOwn(update, 'role');
  const hasCustomRoleUpdate =
    (setUpdate && hasOwn(setUpdate, 'customRoleId')) ||
    (unsetUpdate && hasOwn(unsetUpdate, 'customRoleId')) ||
    hasOwn(update, 'customRoleId');

  const effectiveRole = hasRoleUpdate
    ? ((setUpdate?.role ?? update.role) as ProjectMemberRole | null | undefined)
    : ((current as { role?: ProjectMemberRole }).role ?? null);
  const effectiveCustomRoleId = hasCustomRoleUpdate
    ? ((unsetUpdate && hasOwn(unsetUpdate, 'customRoleId')
        ? null
        : (setUpdate?.customRoleId ?? update.customRoleId)) as string | null | undefined)
    : (((current as { customRoleId?: string | null }).customRoleId ?? null) as
        | string
        | null
        | undefined);

  if (effectiveRole === 'custom') {
    if (typeof effectiveCustomRoleId !== 'string' || effectiveCustomRoleId.trim().length === 0) {
      throw new Error(CUSTOM_ROLE_REQUIRED_MESSAGE);
    }
    return;
  }

  if (effectiveCustomRoleId !== null && effectiveCustomRoleId !== undefined) {
    throw new Error(CUSTOM_ROLE_FORBIDDEN_MESSAGE);
  }
});

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });
ProjectMemberSchema.index({ userId: 1 });
ProjectMemberSchema.index({ customRoleId: 1 }, { sparse: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectMember =
  (mongoose.models.ProjectMember as any) ||
  model<IProjectMember>('ProjectMember', ProjectMemberSchema);
