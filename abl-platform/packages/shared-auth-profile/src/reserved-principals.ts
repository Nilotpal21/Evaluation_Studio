/**
 * Reserved Principals (RP-1 contract)
 *
 * Some auth-profile flows persist tokens against synthetic userIds — for
 * example workspace-scope OAuth grants are stored with `userId='__tenant__'`
 * to indicate "shared by every member of this tenant" rather than belonging
 * to any one human. To prevent collision between these reserved principals
 * and real user records, real user creation must reject any userId that
 * begins with `__` and is not in the approved RESERVED_PRINCIPALS list.
 *
 * Adding a new reserved principal is an explicit, reviewed change here —
 * not a runtime decision — which keeps the synthetic-principal namespace
 * tightly bounded.
 */

import { AuthProfileError } from './errors.js';

/**
 * Approved system principals — `userId` values that may begin with `__`.
 * New entries require explicit registration here (RP-1 contract).
 */
export const RESERVED_PRINCIPALS = ['__tenant__'] as const;

export type ReservedPrincipal = (typeof RESERVED_PRINCIPALS)[number];

function isApprovedReservedPrincipal(userId: string): userId is ReservedPrincipal {
  return (RESERVED_PRINCIPALS as readonly string[]).includes(userId);
}

/**
 * Asserts that a userId may be safely persisted as a real-user identifier
 * (i.e. not a reserved synthetic principal).
 *
 * Throws `AUTH_RESERVED_PRINCIPAL` when:
 *   - `userId` is empty or non-string
 *   - `userId` begins with `__` and is not in the approved list
 *
 * Idempotent for non-reserved values: a UUIDv7 user id is a no-op.
 */
export function assertNotReservedPrincipal(userId: string): void {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new AuthProfileError(
      'AUTH_RESERVED_PRINCIPAL',
      'userId is required for real user creation',
      400,
    );
  }

  if (!userId.startsWith('__')) {
    return;
  }

  if (isApprovedReservedPrincipal(userId)) {
    throw new AuthProfileError(
      'AUTH_RESERVED_PRINCIPAL',
      `userId '${userId}' is a reserved system principal and cannot identify a real user`,
      400,
    );
  }

  throw new AuthProfileError(
    'AUTH_RESERVED_PRINCIPAL',
    `userId starting with '__' is reserved for system principals (got '${userId}')`,
    400,
  );
}
