import { signPlatformAccessToken } from '@agent-platform/shared-auth';

export interface MintWorkflowAuthTokenInput {
  secret: string;
  tenantId: string;
  projectId?: string;
  expiresInSeconds?: number;
}

export const WORKFLOW_AUTH_TOKEN_SUB = 'service:runtime';

export function mintWorkflowAuthToken(input: MintWorkflowAuthTokenInput): string {
  return signPlatformAccessToken(
    {
      sub: WORKFLOW_AUTH_TOKEN_SUB,
      email: 'runtime-internal@service.local',
      type: 'access',
      tokenClass: 'user',
      tenantId: input.tenantId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      role: 'OWNER',
      internal: true,
    },
    input.secret,
    { expiresIn: input.expiresInSeconds ?? 3600 },
  );
}
