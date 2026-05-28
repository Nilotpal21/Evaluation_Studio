/**
 * POST /api/projects/:id/connectors/:connectorName/actions/:actionName/props/:propName/options
 *
 * Resolves dynamic dropdown options for a connector-action prop using the given
 * connection's credentials. Proxies to the workflow-engine, which owns the
 * ConnectorRegistry and the project-scoped ConnectionResolver.
 *
 * Request body: { connectionId: string, propsValue?: Record<string, unknown>, searchValue?: string }
 * Response body: { success: true, data: DropdownState } | { success: false, error: { code, message } }
 *
 * The workflow-engine catalog routes are flat (not under /projects/:id/...),
 * so the projectId travels in the body alongside connectionId.
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
    const actionName = params.actionName;
    const propName = params.propName;
    const projectId = params.id;

    if (
      !connectorName ||
      !actionName ||
      !propName ||
      typeof connectorName !== 'string' ||
      typeof actionName !== 'string' ||
      typeof propName !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'connectorName, actionName, and propName are required',
          },
        },
        { status: 400 },
      );
    }

    // Validate path params to prevent path traversal
    if (
      !PARAM_PATTERN.test(connectorName) ||
      !PARAM_PATTERN.test(actionName) ||
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

    const wePath = `/api/v1/connectors/${connectorName}/actions/${actionName}/props/${propName}/options`;
    return proxyToWorkflowEngine(request, wePath, {
      method: 'POST',
      tenantId,
      body: {
        projectId,
        connectionId,
        propsValue: body.propsValue,
        searchValue: body.searchValue,
      },
    });
  },
);
