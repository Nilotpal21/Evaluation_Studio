/**
 * GET /api/projects/:id/agent-transfer/insights
 *
 * Proxy to KoreAgentAssist analytics APIs.
 * Resolves SmartAssist credentials from the project's connector connection,
 * injects accountId/orgId/appId from connection metadata, and forwards the
 * request to the appropriate analytics endpoint.
 *
 * Query params:
 *   type    — analytics endpoint to call (see ENDPOINT_MAP below)
 *   start   — ISO start date (optional, defaults to 7 days ago)
 *   end     — ISO end date (optional, defaults to now)
 *   + any extra params forwarded verbatim to KoreAgentAssist
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { createAuthProfileResolver } from '@agent-platform/connectors/services';
import { validateUrlForSSRF } from '@agent-platform/shared/security';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('agent-transfer-insights');

const ENDPOINT_MAP: Record<string, string> = {
  chat: '/agentassist/api/v1/internal/analytics/dashboards/efficiency/chat',
  voice: '/agentassist/api/v1/internal/analytics/dashboards/efficiency/voice',
  queues: '/agentassist/api/v1/internal/analytics/dashboards/queueMetrics',
  agents: '/agentassist/api/v1/internal/analytics/dashboards/agents',
  transfers: '/agentassist/api/v1/internal/analytics/dashboards/efficiency/transfers',
  top_skills: '/agentassist/api/v1/internal/analytics/dashboards/topSkills',
  disposition_sets: '/agentassist/api/v1/internal/dispositionSets',
};

const querySchema = z.object({
  type: z.enum([
    'chat',
    'voice',
    'queues',
    'agents',
    'transfers',
    'top_skills',
    'disposition_sets',
  ]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());

    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
        { status: 400 },
      );
    }

    const { type, startDate, endDate } = parsed.data;
    const projectId = params.id;

    try {
      const { ensureDb } = await import('@/lib/ensure-db');
      await ensureDb();

      const { ConnectorConnection, AuthProfile } = await import('@agent-platform/database/models');

      // ABLP-1123: bridge auto-creation removed. Resolve AuthProfile directly
      // first; fall back to legacy ConnectorConnection bridge for existing rows.
      const authProfile = await AuthProfile.findOne({
        tenantId,
        projectId,
        connector: 'smartassist',
        status: 'active',
      }).lean();

      const connDoc = authProfile
        ? null
        : await ConnectorConnection.findOne({
            tenantId,
            projectId,
            connectorName: 'smartassist',
          }).lean();

      const authProfileId = authProfile
        ? String(authProfile._id)
        : typeof connDoc?.authProfileId === 'string'
          ? connDoc.authProfileId
          : null;

      if (!authProfileId) {
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

      const accountId = (metadata.accountId as string | undefined) ?? '';
      const orgId = (metadata.orgId as string | undefined) ?? '';
      const iId = (metadata.appId as string | undefined) ?? '';

      const endpointPath = ENDPOINT_MAP[type];
      const baseUrlClean = baseUrl.replace(/\/$/, '');
      let upstreamUrlForLog = `${baseUrlClean}${endpointPath}`;

      // disposition_sets: GET with query params
      // All analytics endpoints: POST with JSON body
      let upstreamRes: Response;

      if (type === 'disposition_sets') {
        const qParams = new URLSearchParams();
        if (accountId) qParams.set('accountId', accountId);
        if (orgId) qParams.set('orgId', orgId);
        if (iId) qParams.set('iId', iId);
        const upstreamUrl = `${baseUrlClean}${endpointPath}?${qParams.toString()}`;
        upstreamUrlForLog = upstreamUrl;
        log.info('Calling KoreAgentAssist API (GET)', {
          upstreamUrl,
          accountId: accountId || '(empty)',
          orgId: orgId || '(empty)',
          iId: iId || '(empty)',
          hasApiKey: !!apiKey,
        });
        upstreamRes = await fetch(upstreamUrl, {
          method: 'GET',
          headers: { apikey: apiKey, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        const upstreamUrl = `${baseUrlClean}${endpointPath}`;
        const isChatOrVoice = type === 'chat' || type === 'voice';
        const body: Record<string, unknown> = {
          accountId,
          orgId,
          iId,
          timeZone: 'UTC',
          timeZoneOffset: 0,
          queues: [],
          channels: [],
          botchannels: isChatOrVoice ? ['voice', 'rtm'] : [],
          aIds: [],
          channelFilter: 'all',
        };
        if (isChatOrVoice) body.allQueueSelected = true;
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;

        log.info('Calling KoreAgentAssist analytics API (POST)', {
          upstreamUrl,
          accountId: accountId || '(empty)',
          orgId: orgId || '(empty)',
          iId: iId || '(empty)',
          hasApiKey: !!apiKey,
        });
        upstreamRes = await fetch(upstreamUrl, {
          method: 'POST',
          headers: { apikey: apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        log.error('KoreAgentAssist analytics API returned error', {
          status: upstreamRes.status,
          upstreamUrl: upstreamUrlForLog,
          tenantId,
          projectId,
          type,
          error: errText.slice(0, 500),
        });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'UPSTREAM_ERROR',
              message: 'KoreAgentAssist analytics request failed',
            },
          },
          { status: 502 },
        );
      }

      const data = await upstreamRes.json().catch(() => ({}));
      return NextResponse.json({ success: true, data });
    } catch (err) {
      log.error('Failed to fetch agent transfer insights', {
        tenantId,
        projectId,
        type,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to fetch agent transfer analytics',
          },
        },
        { status: 500 },
      );
    }
  },
);
