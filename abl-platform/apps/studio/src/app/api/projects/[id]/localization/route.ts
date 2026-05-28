/**
 * GET  /api/projects/:id/localization - List localization assets for a project
 * POST /api/projects/:id/localization - Create a localization asset
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { formatUserLabel } from '@/lib/auth';
import {
  buildLocalizationAssetKey,
  formatLocalizationAssetJson,
  listProjectLocalizationAssets,
} from '@/lib/localization-assets';

const log = createLogger('localization-assets-route');

const createLocalizationAssetSchema = z
  .object({
    relativePath: z.string().min(1),
    value: z.string(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

export const GET = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;

    const assets = await listProjectLocalizationAssets(projectId, tenantId);
    const localeCodes = [...new Set(assets.map((asset) => asset.localeCode))].sort((a, b) =>
      a.localeCompare(b),
    );

    return NextResponse.json({
      success: true,
      assets,
      summary: {
        totalAssets: assets.length,
        totalLocales: localeCodes.length,
      },
      locales: localeCodes,
    });
  },
);

export const POST = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: createLocalizationAssetSchema,
  },
  async (ctx) => {
    const { tenantId, user, body } = ctx;
    const projectId = ctx.params.id;

    try {
      const key = buildLocalizationAssetKey(body.relativePath);
      const value = formatLocalizationAssetJson(body.value);
      const description = body.description ?? null;
      const { ProjectConfigVariable } = await import('@agent-platform/database/models');

      const existing = await ProjectConfigVariable.findOne({
        projectId,
        tenantId,
        key,
      })
        .lean()
        .select('_id');

      if (existing) {
        return NextResponse.json(
          { success: false, error: 'Localization asset already exists' },
          { status: 409 },
        );
      }

      await ProjectConfigVariable.create({
        tenantId,
        projectId,
        key,
        value,
        description,
        createdBy: formatUserLabel(user),
        updatedBy: formatUserLabel(user),
      });

      const assets = await listProjectLocalizationAssets(projectId, tenantId);
      const created = assets.find((asset) => asset.key === key);
      if (!created) {
        log.error('Created localization asset could not be reloaded', {
          projectId,
          tenantId,
          key,
        });
        return NextResponse.json(
          { success: false, error: 'Localization asset could not be loaded after creation' },
          { status: 500 },
        );
      }

      return NextResponse.json({ success: true, asset: created }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Invalid locale asset path') || message.includes('JSON object')) {
        return NextResponse.json({ success: false, error: message }, { status: 400 });
      }
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      ) {
        return NextResponse.json(
          { success: false, error: 'Localization asset already exists' },
          { status: 409 },
        );
      }

      log.error('Failed to create localization asset', {
        projectId,
        tenantId,
        error: message,
      });

      return NextResponse.json(
        { success: false, error: 'Failed to create localization asset' },
        { status: 500 },
      );
    }
  },
);
