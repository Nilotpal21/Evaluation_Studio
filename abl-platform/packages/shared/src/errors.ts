/**
 * Centralized error handling for Agent Platform.
 *
 * Re-exports from @agent-platform/shared-kernel for backwards compatibility.
 */
export {
  AppError,
  ValidationError,
  ErrorCodes,
  toErrorResponse,
  errorToResponse,
  type ErrorCode,
  type ErrorCodeEntry,
} from '@agent-platform/shared-kernel/errors';
