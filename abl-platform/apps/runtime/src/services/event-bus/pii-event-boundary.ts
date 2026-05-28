import {
  renderValueForPIIBoundary,
  type PIIBoundaryContext,
} from '@abl/compiler/platform/security/index.js';

export interface EventPIIContext extends PIIBoundaryContext {}

export function renderPayloadForPipelineEvent<T>(
  payload: T,
  context: EventPIIContext | undefined,
  role?: string,
): T {
  return renderValueForPIIBoundary(payload, context, { consumer: 'pipeline_read', role });
}
