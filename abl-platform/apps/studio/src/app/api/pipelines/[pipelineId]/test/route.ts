/**
 * POST /api/pipelines/:pipelineId/test - Start a manual pipeline test run
 */

import { z } from 'zod';
import { formatUserLabel } from '@/lib/auth';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRestateIngressUrl } from '@/lib/restate-url';
import { withRouteHandler } from '@/lib/route-handler';

const MAX_TRIGGER_INPUT_BYTES = 256 * 1024;
const TEST_RATE_LIMIT = { limit: 10, windowMs: 60_000, scope: 'user' } as const;

const ManualPipelineTestSchema = z
  .object({
    projectId: z.string().min(1),
    triggerId: z.string().min(1),
    data: z.record(z.unknown()),
  })
  .strict();

const MANUAL_TRIGGER_ERROR_CODES = [
  'PIPELINE_NOT_FOUND',
  'PROJECT_MISMATCH',
  'TRIGGER_NOT_FOUND',
  'TRIGGER_NOT_ACTIVE',
  'INPUT_VALIDATION_FAILED',
] as const;

type ManualTriggerErrorCode = (typeof MANUAL_TRIGGER_ERROR_CODES)[number];

function extractManualTriggerErrorCode(message: string): ManualTriggerErrorCode | null {
  const match = message.match(
    /\b(PIPELINE_NOT_FOUND|PROJECT_MISMATCH|TRIGGER_NOT_FOUND|TRIGGER_NOT_ACTIVE|INPUT_VALIDATION_FAILED)\b/,
  );

  return match ? (match[1] as ManualTriggerErrorCode) : null;
}

export const POST = withRouteHandler(
  {
    bodySchema: ManualPipelineTestSchema,
    rateLimit: TEST_RATE_LIMIT,
  },
  async ({ body, user, tenantId, params }) => {
    const access = await requireProjectAccess(body.projectId, user);
    if (isAccessError(access)) {
      return access;
    }

    const inputBytes = Buffer.byteLength(JSON.stringify(body.data), 'utf8');
    if (inputBytes > MAX_TRIGGER_INPUT_BYTES) {
      return errorJson('Input exceeds 256 KB', 413, ErrorCode.VALIDATION_ERROR);
    }

    const triggerResponse = await fetch(`${getRestateIngressUrl()}/PipelineTrigger/triggerManual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: params.pipelineId,
        tenantId,
        projectId: body.projectId,
        triggeredBy: formatUserLabel(user),
        triggerId: body.triggerId,
        data: body.data,
      }),
    });

    if (!triggerResponse.ok) {
      const errorText = await triggerResponse.text().catch(() => '');
      const errorCode = extractManualTriggerErrorCode(errorText);

      switch (errorCode) {
        case 'PIPELINE_NOT_FOUND':
        case 'PROJECT_MISMATCH':
        case 'TRIGGER_NOT_FOUND':
          return errorJson('Pipeline or trigger not found', 404, ErrorCode.NOT_FOUND);
        case 'TRIGGER_NOT_ACTIVE':
          return errorJson('Trigger is not active', 409, ErrorCode.VALIDATION_ERROR);
        case 'INPUT_VALIDATION_FAILED':
          return errorJson('Input failed validation', 400, ErrorCode.VALIDATION_ERROR);
        default:
          return errorJson('Failed to start test run', 502, ErrorCode.INTERNAL_ERROR);
      }
    }

    const payload = (await triggerResponse.json().catch(() => null)) as { runId?: string } | null;
    if (!payload?.runId) {
      return errorJson('Failed to start test run', 502, ErrorCode.INTERNAL_ERROR);
    }

    return actionJson({ runId: payload.runId }, 202);
  },
);
