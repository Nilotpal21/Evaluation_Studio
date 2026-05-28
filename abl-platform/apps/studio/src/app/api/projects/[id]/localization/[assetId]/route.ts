/**
 * GET    /api/projects/:id/localization/:assetId - Get a localization asset
 * PATCH  /api/projects/:id/localization/:assetId - Update a localization asset
 * DELETE /api/projects/:id/localization/:assetId - Delete a localization asset
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { formatUserLabel } from '@/lib/auth';
import {
  buildLocalizationAssetKey,
  formatLocalizationAssetJson,
  getProjectLocalizationAssetById,
} from '@/lib/localization-assets';

const log = createLogger('localization-asset-route');

const updateLocalizationAssetSchema = z
  .object({
    relativePath: z.string().min(1).optional(),
    value: z.string().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.relativePath !== undefined ||
      value.value !== undefined ||
      value.description !== undefined,
    {
      message: 'At least one field must be provided',
    },
  );

export const GET = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
  },
  async (ctx) => {
    const { tenantId } = ctx;
    const projectId = ctx.params.id;
    const assetId = ctx.params.assetId;

    const asset = await getProjectLocalizationAssetById(assetId, projectId, tenantId);
    if (!asset) {
      return NextResponse.json(
        { success: false, error: 'Localization asset not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, asset });
  },
);

export const PATCH = withRouteHandler(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: updateLocalizationAssetSchema,
  },
  async (ctx) => {
    const { tenantId, user, body } = ctx;
    const projectId = ctx.params.id;
    const assetId = ctx.params.assetId;

    try {
      const { ProjectConfigVariable } = await import('@agent-platform/database/models');
      const existing = await ProjectConfigVariable.findOne({
        _id: assetId,
        projectId,
        tenantId,
        key: /^locale:/,
      })
        .lean()
        .select('_id key');

      if (!existing || !existing.key) {
        return NextResponse.json(
          { success: false, error: 'Localization asset not found' },
          { status: 404 },
        );
      }

      const nextKey = body.relativePath
        ? buildLocalizationAssetKey(body.relativePath)
        : existing.key;
      if (nextKey !== existing.key) {
        const duplicate = await ProjectConfigVariable.findOne({
          projectId,
          tenantId,
          key: nextKey,
          _id: { $ne: assetId },
        })
          .lean()
          .select('_id');

        if (duplicate) {
          return NextResponse.json(
            { success: false, error: 'Localization asset already exists' },
            { status: 409 },
          );
        }
      }

      const updates: Record<string, unknown> = {
        updatedBy: formatUserLabel(user),
      };
      if (body.relativePath !== undefined) {
        updates.key = nextKey;
      }
      if (body.value !== undefined) {
        updates.value = formatLocalizationAssetJson(body.value);
      }
      if (body.description !== undefined) {
        updates.description = body.description;
      }

      const updated = await ProjectConfigVariable.findOneAndUpdate(
        {
          _id: assetId,
          projectId,
          tenantId,
          key: /^locale:/,
        },
        { $set: updates },
        { new: true },
      )
        .lean()
        .select('_id key value description createdAt updatedAt');

      if (!updated) {
        return NextResponse.json(
          { success: false, error: 'Localization asset not found' },
          { status: 404 },
        );
      }

      const asset = await getProjectLocalizationAssetById(assetId, projectId, tenantId);
      if (!asset) {
        return NextResponse.json(
          { success: false, error: 'Localization asset could not be loaded after update' },
          { status: 500 },
        );
      }

      return NextResponse.json({ success: true, asset });
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

      log.error('Failed to update localization asset', {
        projectId,
        tenantId,
        assetId,
        error: message,
      });

      return NextResponse.json(
        { success: false, error: 'Failed to update localization asset' },
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
    const assetId = ctx.params.assetId;

    const { ProjectConfigVariable } = await import('@agent-platform/database/models');
    const deleted = await ProjectConfigVariable.findOneAndDelete({
      _id: assetId,
      projectId,
      tenantId,
      key: /^locale:/,
    })
      .lean()
      .select('_id');

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Localization asset not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, deleted: assetId });
  },
);
