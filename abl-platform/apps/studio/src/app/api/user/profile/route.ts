/**
 * GET   /api/user/profile — Read own profile (name, email, avatar)
 * PATCH /api/user/profile — Update own name or avatarUrl
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { findUserById, updateUser } from '@/repos/auth-repo';

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().max(2048).nullish(),
});

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    const user = await findUserById(authResult.id);
    if (!user) {
      return errorJson('User not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({
      success: true,
      profile: {
        id: user.id,
        email: user.email,
        name: user.name || null,
        avatarUrl: user.avatarUrl || null,
        createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'UserProfile.GET');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => {
        const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
        return `${prefix}${i.message}`;
      });
      return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    const { name, avatarUrl } = parsed.data;

    if (name === undefined && avatarUrl === undefined) {
      return errorJson('No fields to update', 400, ErrorCode.VALIDATION_ERROR);
    }

    const updates: { name?: string; avatarUrl?: string | null } = {};
    if (name !== undefined) updates.name = name;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl ?? null;

    const updated = await updateUser(authResult.id, updates);
    if (!updated) {
      return errorJson('User not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({
      success: true,
      profile: {
        id: updated.id,
        email: updated.email,
        name: updated.name || null,
        avatarUrl: updated.avatarUrl || null,
        createdAt: updated.createdAt ? new Date(updated.createdAt).toISOString() : null,
      },
    });
  } catch (error: unknown) {
    return handleApiError(error, 'UserProfile.PATCH');
  }
}
