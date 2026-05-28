/**
 * Auth Context Helper
 *
 * @deprecated Use `withAdminRoute` from `./with-admin-route` instead.
 * This reads x-admin-user-* headers set by Edge middleware, which is
 * unreliable with Turbopack/Next.js 16 header propagation.
 */

import { headers } from 'next/headers';

export interface AdminAuthContext {
  userId: string;
  email: string;
  role: string;
  ipAddress: string;
}

export async function getAuthContext(): Promise<AdminAuthContext> {
  const hdrs = await headers();
  return {
    userId: hdrs.get('x-admin-user-id') ?? '',
    email: hdrs.get('x-admin-user-email') ?? '',
    role: hdrs.get('x-admin-user-role') ?? '',
    ipAddress: hdrs.get('x-forwarded-for') ?? hdrs.get('x-real-ip') ?? 'unknown',
  };
}
