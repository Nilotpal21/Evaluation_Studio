/**
 * Project Member Repository
 *
 * MongoDB repository for project member operations and related lookups used by
 * the project member service.
 */

import { ensureDb } from '@/lib/ensure-db';

function normalizeId<T extends { _id?: string; id?: string }>(doc: T | null): any {
  if (!doc) return null;
  const { _id, ...rest } = doc as any;
  return { ...rest, id: _id || rest.id };
}

function normalizeIds<T extends { _id?: string; id?: string }>(docs: T[]): any[] {
  return docs.map(normalizeId);
}

export async function findProjectMembers(
  projectId: string,
  opts?: { includeUser?: boolean },
): Promise<any[]> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const docs = await ProjectMember.find({ projectId }).sort({ createdAt: 1 }).lean();

  if (opts?.includeUser) {
    const { User } = await import('@agent-platform/database/models');
    const userIds = docs.map((doc: any) => doc.userId);
    const users = await User.find({ _id: { $in: userIds } }).lean();
    const userMap = new Map(users.map((user: any) => [String(user._id), normalizeId(user)]));

    return docs.map((doc: any) => ({
      ...normalizeId(doc),
      user: userMap.get(String(doc.userId)) || null,
    }));
  }

  return normalizeIds(docs);
}

export async function findProjectMember(projectId: string, userId: string): Promise<any | null> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const doc = await ProjectMember.findOne({ projectId, userId }).lean();
  return normalizeId(doc);
}

export async function findProjectMembershipsByUserId(userId: string): Promise<any[]> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const docs = await ProjectMember.find({ userId }).lean();
  return normalizeIds(docs);
}

export async function createProjectMember(data: {
  projectId: string;
  userId: string;
  role: string;
  customRoleId?: string | null;
}): Promise<any> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const doc = await ProjectMember.create({
    projectId: data.projectId,
    userId: data.userId,
    role: data.role,
    customRoleId: data.customRoleId ?? null,
  });
  return normalizeId(doc.toObject());
}

export async function updateProjectMember(
  projectId: string,
  userId: string,
  data: { role?: string; customRoleId?: string | null },
): Promise<any | null> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const doc = await ProjectMember.findOneAndUpdate(
    { projectId, userId },
    { $set: data },
    { new: true, runValidators: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteProjectMember(projectId: string, userId: string): Promise<boolean> {
  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const result = await ProjectMember.deleteOne({ projectId, userId });
  return result.deletedCount > 0;
}

export async function deleteProjectMembersByProjectIds(
  projectIds: string[],
  userId: string,
): Promise<number> {
  if (projectIds.length === 0) {
    return 0;
  }

  await ensureDb();
  const { ProjectMember } = await import('@agent-platform/database/models');
  const result = await ProjectMember.deleteMany({
    projectId: { $in: projectIds },
    userId,
  });
  return result.deletedCount || 0;
}

export async function findCustomRoleDefinition(
  tenantId: string,
  customRoleId: string,
): Promise<any | null> {
  await ensureDb();
  const { RoleDefinition } = await import('@agent-platform/database/models');
  const doc = await RoleDefinition.findOne({
    _id: customRoleId,
    tenantId,
    isSystem: false,
  }).lean();
  return normalizeId(doc);
}
