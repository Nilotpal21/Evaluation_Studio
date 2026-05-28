/**
 * Discriminated Auth Context Types
 *
 * Re-exports from @agent-platform/shared-kernel for backwards compatibility.
 */
export type {
  CallerIdentity,
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
} from '@agent-platform/shared-kernel';
export { isPlatformMember, isChannelUser, isApiKey } from '@agent-platform/shared-kernel';
