/**
 * POST /api/projects/:id/connectors/:connectorName/triggers/:triggerName/props/:propName/dynamic-fields
 *
 * Resolves the DynamicProperties field map for a connector-trigger prop using the given
 * connection's credentials. Proxies to the workflow-engine.
 *
 * Request body: { connectionId: string, propsValue?: Record<string, unknown> }
 * Response body: { success: true, data: DynamicPropertiesState } | { success: false, error: { code, message } }
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { proxyToWorkflowEngine } from '@/lib/workflow-engine-proxy';
import { StudioPermission } from '@/lib/permissions';

const PARAM_PATTERN = /^[a-z0-9@_-]+$/i;

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: [StudioPermission.WORKFLOW_READ, StudioPermission.CONNECTION_READ],
  },
  async ({ request, tenantId, params }) => {
    const connectorName = params.connectorName;
    const triggerName = params.triggerName;
    const propName = params.propName;
    const projectId = params.id;

    if (
      !connectorName ||
      !triggerName ||
      !propName ||
      typeof connectorName !== 'string' ||
      typeof triggerName !== 'string' ||
      typeof propName !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'connectorName, triggerName, and propName are required',
          },
        },
        { status: 400 },
      );
    }

    if (
      !PARAM_PATTERN.test(connectorName) ||
      !PARAM_PATTERN.test(triggerName) ||
      !PARAM_PATTERN.test(propName)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'Invalid path parameter format' },
        },
        { status: 400 },
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // Treat unparseable body as empty — workflow-engine will return VALIDATION_ERROR
    }

    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined;
    if (!connectionId) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'connectionId is required' },
        },
        { status: 400 },
      );
    }

    return proxyToWorkflowEngine(
      request,
      `/api/v1/connectors/${connectorName}/triggers/${triggerName}/props/${propName}/dynamic-fields`,
      {
        method: 'POST',
        tenantId,
        body: {
          projectId,
          connectionId,
          propsValue: body.propsValue,
        },
      },
    );
  },
);
