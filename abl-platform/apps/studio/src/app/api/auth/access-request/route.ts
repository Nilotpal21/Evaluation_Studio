/**
 * POST /api/auth/access-request
 * Notify platform admins when a user from a non-allowlisted domain requests access.
 */

import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import {
  handler,
  accessRequestSchema,
  accessRequestResponseSchema,
} from './access-request-handler';

export const POST = withOpenAPI(
  {
    summary: 'Request platform access',
    description:
      'Sends an access request email to platform admins when the requester email domain is not allowlisted.',
    body: accessRequestSchema,
    response: accessRequestResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);
