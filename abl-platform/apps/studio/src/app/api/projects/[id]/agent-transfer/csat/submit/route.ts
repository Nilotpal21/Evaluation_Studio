/**
 * POST /api/projects/:id/agent-transfer/csat/submit
 *
 * Resolves the project's SmartAssist connector credentials and calls the
 * SmartAssist CSAT API directly — no ABL runtime proxy needed.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { createAuthProfileResolver } from '@agent-platform/connectors/services';
import { validateUrlForSSRF } from '@agent-platform/shared/security';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('agent-transfer-csat');

const submitCsatSchema = z
  .object({
    provider: z.string().min(1),
    userId: z.string().min(1),
    channel: z.string().min(1),
    botId: z.string().min(1),
    orgId: z.string().min(1),
    conversationId: z.string().min(1),
    score: z.number().int().min(0).max(10),
    surveyType: z.enum(['csat', 'nps', 'likeDislike']).default('csat'),
    comments: z.string().max(1000).optional(),
  })
  .strict();

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON' } },
        { status: 400 },
      );
    }

    const parsed = submitCsatSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
        { status: 400 },
      );
    }

    const { provider, userId, channel, botId, orgId, conversationId, score, surveyType, comments } =
      parsed.data;
    const projectId = params.id;

    try {
      const { ensureDb } = await import('@/lib/ensure-db');
      await ensureDb();

      const { ConnectorConnection, AuthProfile } = await import('@agent-platform/database/models');

      // Resolve the agent-transfer profile. Look up AuthProfile directly first
      // (ABLP-1123: bridge auto-creation removed). Fall back to legacy
      // ConnectorConnection for existing bridges still in the DB.
      const authProfile = await AuthProfile.findOne({
        tenantId,
        projectId,
        connector: provider,
        status: 'active',
      }).lean();

      const connDoc = authProfile
        ? null
        : await ConnectorConnection.findOne({
            tenantId,
            projectId,
            connectorName: provider,
          }).lean();

      const authProfileId = authProfile
        ? String(authProfile._id)
        : typeof connDoc?.authProfileId === 'string'
          ? connDoc.authProfileId
          : null;

      if (!authProfileId) {
        log.error('No SmartAssist connection found for project', { tenantId, projectId, provider });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'CONNECTION_NOT_FOUND',
              message: 'No agent transfer connection configured for this project',
            },
          },
          { status: 404 },
        );
      }

      const resolver = createAuthProfileResolver({ authProfileModel: AuthProfile as any });
      const creds = await resolver.resolve({
        authProfileId,
        tenantId,
        projectId,
      });

      const metadataSource = authProfile
        ? (authProfile as { config?: unknown }).config
        : connDoc?.metadata;
      const metadata =
        metadataSource && typeof metadataSource === 'object' && !Array.isArray(metadataSource)
          ? (metadataSource as Record<string, unknown>)
          : {};

      // SmartAssist baseUrl resolution order (ABLP-1123):
      //   1. metadata.baseUrl — historical: only ever populated by a manual
      //      ConnectorConnection setup flow. Auto-bridges never wrote this,
      //      and AuthProfile.config uses OAuth-style keys, not `baseUrl`.
      //      Kept as the first fallback for legacy rows.
      //   2. creds.baseUrl — resolved by the AuthProfile resolver.
      //   3. SMARTASSIST_API_URL / SMARTASSIST_URL env — the canonical
      //      production source; deployment guarantees one is set.
      const baseUrl =
        (metadata.baseUrl as string | undefined) ??
        (creds.baseUrl as string | undefined) ??
        process.env.SMARTASSIST_API_URL ??
        process.env.SMARTASSIST_URL;
      const apiKey =
        (creds.koreApiKey as string | undefined) ??
        (creds.apiKey as string | undefined) ??
        process.env.KORE_INTERNAL_API_KEY ??
        process.env.SMARTASSIST_API_KEY;

      if (!baseUrl || !apiKey) {
        log.error('SmartAssist connection missing baseUrl or apiKey', {
          tenantId,
          projectId,
          provider,
        });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'MISCONFIGURED_CONNECTION',
              message: 'SmartAssist connection credentials are incomplete',
            },
          },
          { status: 502 },
        );
      }

      const ssrfCheck = validateUrlForSSRF(baseUrl, getDevSSRFOptions());
      if (!ssrfCheck.safe) {
        log.error('SmartAssist connection URL blocked by SSRF protection', {
          tenantId,
          projectId,
          provider,
          reason: ssrfCheck.reason,
        });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'MISCONFIGURED_CONNECTION',
              message: 'SmartAssist connection URL is not allowed',
            },
          },
          { status: 502 },
        );
      }

      const smartassistUrl = `${baseUrl.replace(/\/$/, '')}/agentassist/api/v1/csatResponse/save`;
      const smartassistRes = await fetch(smartassistUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: apiKey },
        body: JSON.stringify({
          userId,
          channel,
          botId,
          orgId,
          conversationId,
          score,
          surveyType,
          ...(comments ? { comments } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!smartassistRes.ok) {
        const errText = await smartassistRes.text().catch(() => '');
        log.error('SmartAssist CSAT API returned error', {
          status: smartassistRes.status,
          tenantId,
          projectId,
          error: errText.slice(0, 500),
        });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'SMARTASSIST_ERROR',
              message: 'SmartAssist CSAT submission failed',
            },
          },
          { status: 502 },
        );
      }

      const responseText = await smartassistRes.text().catch(() => '');
      return NextResponse.json({ success: true, data: { message: responseText } });
    } catch (err) {
      log.error('Failed to submit CSAT rating', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to submit CSAT rating' },
        },
        { status: 500 },
      );
    }
  },
);
