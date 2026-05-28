import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { ProjectAgent, ProjectConfigVariable } from '@agent-platform/database/models';
import { formatUserLabel } from '@/lib/auth';
import { refreshProjectAgentDraftMetadataForConfigMutation } from '@/lib/project-config-draft-invalidation';
import { withRouteHandler } from '@/lib/route-handler';
import {
  buildBehaviorProfileConfigKey,
  buildProfileUsageMap,
  buildStructuredBehaviorProfileDsl,
  parseStoredBehaviorProfile,
} from '../_helpers';

const log = createLogger('behavior-profile-route');

const conversationBehaviorSchema = z
  .object({
    speaking: z.record(z.unknown()).optional(),
    listening: z.record(z.unknown()).optional(),
    interaction: z.record(z.unknown()).optional(),
  })
  .strict()
  .optional();

const updateBehaviorProfileSchema = z
  .object({
    mode: z.enum(['raw', 'structured']),
    dslContent: z.string().optional(),
    baseDslContent: z.string().optional(),
    name: z.string().min(1).optional(),
    priority: z.number().int().min(0).optional(),
    whenExpression: z.string().min(1).optional(),
    conversationBehavior: conversationBehaviorSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'raw') {
      if (!value.dslContent || value.dslContent.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dslContent is required when mode is raw',
          path: ['dslContent'],
        });
      }
      return;
    }

    if (!value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'name is required when mode is structured',
        path: ['name'],
      });
    }
    if (value.priority === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'priority is required when mode is structured',
        path: ['priority'],
      });
    }
    if (!value.whenExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'whenExpression is required when mode is structured',
        path: ['whenExpression'],
      });
    }
  });

export const GET = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;
    const requestedName = decodeURIComponent(ctx.params.profileName);
    const key = buildBehaviorProfileConfigKey(requestedName);

    const [profileDoc, agentDocs] = await Promise.all([
      ProjectConfigVariable.findOne({
        projectId,
        tenantId,
        key,
      })
        .lean()
        .select('key value updatedAt') as Promise<{
        key: string;
        value: string;
        updatedAt: Date;
      } | null>,
      ProjectAgent.find({ projectId, tenantId }).select('name dslContent').lean() as Promise<
        Array<{ name: string; dslContent: string }>
      >,
    ]);

    if (!profileDoc) {
      return NextResponse.json(
        { success: false, error: 'Behavior profile not found' },
        { status: 404 },
      );
    }

    const usageMap = buildProfileUsageMap(agentDocs);
    const parsed = parseStoredBehaviorProfile(profileDoc.value, requestedName);

    return NextResponse.json({
      success: true,
      profile: {
        name: parsed.name,
        priority: parsed.priority,
        whenExpression: parsed.whenExpression,
        conversationBehavior: parsed.conversationBehavior,
        overrideCategories: parsed.overrideCategories,
        usedByAgents: usageMap.get(parsed.name) ?? [],
        dslContent: profileDoc.value,
        updatedAt: profileDoc.updatedAt.toISOString(),
        parseErrors: parsed.parseErrors,
        semanticErrors: parsed.semanticErrors,
      },
    });
  },
);

export const PATCH = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: updateBehaviorProfileSchema,
  },
  async (ctx) => {
    const { tenantId, user, body } = ctx;
    const projectId = ctx.params.id;
    const requestedName = decodeURIComponent(ctx.params.profileName);
    const currentKey = buildBehaviorProfileConfigKey(requestedName);

    try {
      const existing = await ProjectConfigVariable.findOne({
        projectId,
        tenantId,
        key: currentKey,
      })
        .lean()
        .select('_id key value updatedAt');

      if (!existing) {
        return NextResponse.json(
          { success: false, error: 'Behavior profile not found' },
          { status: 404 },
        );
      }

      const dslContent =
        body.mode === 'raw'
          ? body.dslContent!
          : buildStructuredBehaviorProfileDsl({
              name: body.name!,
              priority: body.priority!,
              whenExpression: body.whenExpression!,
              conversationBehavior: body.conversationBehavior,
              baseDslContent: body.baseDslContent ?? existing.value,
            });

      const parsed = parseStoredBehaviorProfile(dslContent, body.name ?? requestedName);
      const validationErrors = [...parsed.parseErrors, ...parsed.semanticErrors];
      if (validationErrors.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'Behavior profile ABL is invalid',
            details: validationErrors,
          },
          { status: 400 },
        );
      }

      const agentDocs = (await ProjectAgent.find({ projectId, tenantId })
        .select('name dslContent')
        .lean()) as Array<{
        name: string;
        dslContent: string;
      }>;
      const usageMap = buildProfileUsageMap(agentDocs);
      const attachedAgents = usageMap.get(requestedName) ?? [];

      if (parsed.name !== requestedName && attachedAgents.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'Behavior profile is in use and cannot be renamed',
            usedByAgents: attachedAgents,
          },
          { status: 409 },
        );
      }

      const nextKey = buildBehaviorProfileConfigKey(parsed.name);
      if (nextKey !== currentKey) {
        const duplicate = await ProjectConfigVariable.findOne({
          projectId,
          tenantId,
          key: nextKey,
          _id: { $ne: existing._id },
        })
          .lean()
          .select('_id');

        if (duplicate) {
          return NextResponse.json(
            { success: false, error: 'Behavior profile already exists' },
            { status: 409 },
          );
        }
      }

      const actor = formatUserLabel(user);
      const updated = await ProjectConfigVariable.findOneAndUpdate(
        {
          _id: existing._id,
          projectId,
          tenantId,
          key: currentKey,
        },
        {
          $set: {
            key: nextKey,
            value: dslContent,
            updatedBy: actor,
          },
          $inc: { _v: 1 },
        },
        { new: true },
      )
        .lean()
        .select('value updatedAt');

      if (!updated) {
        return NextResponse.json(
          { success: false, error: 'Behavior profile not found' },
          { status: 404 },
        );
      }
      await refreshProjectAgentDraftMetadataForConfigMutation({
        projectId,
        tenantId,
      });

      return NextResponse.json({
        success: true,
        profile: {
          name: parsed.name,
          priority: parsed.priority,
          whenExpression: parsed.whenExpression,
          conversationBehavior: parsed.conversationBehavior,
          overrideCategories: parsed.overrideCategories,
          usedByAgents: usageMap.get(parsed.name) ?? [],
          dslContent,
          updatedAt:
            updated.updatedAt instanceof Date
              ? updated.updatedAt.toISOString()
              : new Date(updated.updatedAt).toISOString(),
          parseErrors: [],
          semanticErrors: [],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      ) {
        return NextResponse.json(
          { success: false, error: 'Behavior profile already exists' },
          { status: 409 },
        );
      }

      log.error('Failed to update behavior profile', {
        projectId,
        tenantId,
        requestedName,
        error: message,
      });

      return NextResponse.json(
        { success: false, error: 'Failed to update behavior profile' },
        { status: 500 },
      );
    }
  },
);

export const DELETE = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;
    const requestedName = decodeURIComponent(ctx.params.profileName);
    const key = buildBehaviorProfileConfigKey(requestedName);

    const existing = await ProjectConfigVariable.findOne({
      projectId,
      tenantId,
      key,
    })
      .lean()
      .select('_id');

    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Behavior profile not found' },
        { status: 404 },
      );
    }

    const agentDocs = (await ProjectAgent.find({ projectId, tenantId })
      .select('name dslContent')
      .lean()) as Array<{
      name: string;
      dslContent: string;
    }>;
    const usageMap = buildProfileUsageMap(agentDocs);
    const attachedAgents = usageMap.get(requestedName) ?? [];

    if (attachedAgents.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Behavior profile is in use and cannot be deleted',
          usedByAgents: attachedAgents,
        },
        { status: 409 },
      );
    }

    await ProjectConfigVariable.findOneAndDelete({ _id: existing._id, projectId, tenantId, key })
      .lean()
      .select('_id');
    await refreshProjectAgentDraftMetadataForConfigMutation({
      projectId,
      tenantId,
    });

    return NextResponse.json({ success: true, deleted: requestedName });
  },
);
