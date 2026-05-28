/**
 * GET/PUT /api/projects/[id]/arch-conversation
 *
 * Load and save the authenticated user's Arch AI conversation for a project.
 * Each user has a private conversation per project — not shared with teammates.
 *
 * GET  → returns { messages: ArchMessage[], lastActivityAt: string }
 * PUT  → upserts { messages: ArchMessage[] }, returns { success: true }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureDb } from '@/lib/ensure-db';

// ─── Schema ────────────────────────────────────────────────────────────

/** Max length for a single message's content */
const MAX_MESSAGE_CONTENT = 10_000;

const messageSchema = z.object({
  id: z.string().max(200),
  role: z.enum(['arch', 'user']),
  content: z.string().max(MAX_MESSAGE_CONTENT),
  timestamp: z.string().max(50),
  agentName: z.string().max(200).optional(),
});

const putBodySchema = z.object({
  messages: z.array(messageSchema).max(100),
});

// ─── Types ─────────────────────────────────────────────────────────────

type RouteParams = { params: Promise<{ id: string }> };

// ─── GET ───────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { ArchConversation } = await import('@agent-platform/database/models');
    const doc = await ArchConversation.findOne({
      userId: user.id,
      projectId,
    }).lean();

    if (!doc) {
      return NextResponse.json({
        success: true,
        data: { messages: [], lastActivityAt: null },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        messages: doc.messages,
        lastActivityAt: doc.lastActivityAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    console.error('[Arch Conversation] GET error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load conversation' } },
      { status: 500 },
    );
  }
}

// ─── PUT ───────────────────────────────────────────────────────────────

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const parsed = putBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
      { status: 400 },
    );
  }

  await ensureDb();

  try {
    const { ArchConversation } = await import('@agent-platform/database/models');

    await ArchConversation.findOneAndUpdate(
      { userId: user.id, projectId },
      {
        $set: {
          messages: parsed.data.messages,
          lastActivityAt: new Date(),
        },
        $setOnInsert: {
          userId: user.id,
          projectId,
        },
      },
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Arch Conversation] PUT error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to save conversation' } },
      { status: 500 },
    );
  }
}

// ─── DELETE ────────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { ArchConversation } = await import('@agent-platform/database/models');
    await ArchConversation.deleteOne({ userId: user.id, projectId });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Arch Conversation] DELETE error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete conversation' },
      },
      { status: 500 },
    );
  }
}
