export {
  matchesSessionOwner,
  isElevatedPlatformRole,
  matchesPlatformMemberSessionOwner,
  buildSessionListFilter,
  evaluateSessionOwnershipAccess,
  createRequireSessionOwnership,
} from '@agent-platform/shared-auth/middleware';
export type {
  SessionOwnershipConfig,
  SessionOwnershipSubject,
  SessionOwnershipEvaluation,
} from '@agent-platform/shared-auth/middleware';
