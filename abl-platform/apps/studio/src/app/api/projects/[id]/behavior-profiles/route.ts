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
} from './_helpers';

const log = createLogger('behavior-profiles-route');

const conversationBehaviorSchema = z
  .object({
    speaking: z.record(z.unknown()).optional(),
    listening: z.record(z.unknown()).optional(),
    interaction: z.record(z.unknown()).optional(),
  })
  .strict()
  .optional();

const createBehaviorProfileSchema = z
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

    const [profileDocs, agentDocs] = await Promise.all([
      ProjectConfigVariable.find({
        projectId,
        tenantId,
        key: /^profile:/,
      })
        .select('key value updatedAt')
        .lean() as Promise<Array<{ key: string; value: string; updatedAt: Date }>>,
      ProjectAgent.find({ projectId, tenantId }).select('name dslContent').lean() as Promise<
        Array<{ name: string; dslContent: string }>
      >,
    ]);

    const usageMap = buildProfileUsageMap(agentDocs);
    const profiles = profileDocs
      .map((doc) => {
        const parsed = parseStoredBehaviorProfile(doc.value, doc.key.replace(/^profile:/, ''));
        return {
          name: parsed.name,
          priority: parsed.priority,
          whenExpression: parsed.whenExpression,
          dslContent: doc.value,
          overrideCategories: parsed.overrideCategories,
          usedByAgents: usageMap.get(parsed.name) ?? [],
          updatedAt: doc.updatedAt.toISOString(),
          parseErrors: parsed.parseErrors,
          semanticErrors: parsed.semanticErrors,
        };
      })
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

    return NextResponse.json({ success: true, profiles });
  },
);

export const POST = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: createBehaviorProfileSchema,
  },
  async (ctx) => {
    const { tenantId, user, body } = ctx;
    const projectId = ctx.params.id;

    try {
      const dslContent =
        body.mode === 'raw'
          ? body.dslContent!
          : buildStructuredBehaviorProfileDsl({
              name: body.name!,
              priority: body.priority!,
              whenExpression: body.whenExpression!,
              conversationBehavior: body.conversationBehavior,
              baseDslContent: body.baseDslContent,
            });

      const parsed = parseStoredBehaviorProfile(dslContent, body.name);
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

      const key = buildBehaviorProfileConfigKey(parsed.name);
      const existing = await ProjectConfigVariable.findOne({
        projectId,
        tenantId,
        key,
      })
        .lean()
        .select('_id');

      if (existing) {
        return NextResponse.json(
          { success: false, error: 'Behavior profile already exists' },
          { status: 409 },
        );
      }

      const actor = formatUserLabel(user);
      await ProjectConfigVariable.create({
        tenantId,
        projectId,
        key,
        value: dslContent,
        description: null,
        createdBy: actor,
        updatedBy: actor,
      });
      await refreshProjectAgentDraftMetadataForConfigMutation({
        projectId,
        tenantId,
      });

      return NextResponse.json(
        {
          success: true,
          profile: {
            name: parsed.name,
            priority: parsed.priority,
            whenExpression: parsed.whenExpression,
            conversationBehavior: parsed.conversationBehavior,
            overrideCategories: parsed.overrideCategories,
            usedByAgents: [],
            dslContent,
            parseErrors: [],
            semanticErrors: [],
          },
        },
        { status: 201 },
      );
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

      log.error('Failed to create behavior profile', {
        projectId,
        tenantId,
        error: message,
      });

      return NextResponse.json(
        { success: false, error: 'Failed to create behavior profile' },
        { status: 500 },
      );
    }
  },
);
