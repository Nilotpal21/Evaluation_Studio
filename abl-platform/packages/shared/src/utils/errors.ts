/**
 * Error Handling Utilities
 *
 * Re-exports from @agent-platform/shared-kernel for backwards compatibility.
 */
export {
  getErrorMessage,
  getErrorStack,
  toErrorResult,
  ToolExecutionError,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  OAUTH_TOKEN_TIMEOUT_MS,
  MCP_RETRY_DELAY_BASE_MS,
  type ToolErrorCode,
} from '@agent-platform/shared-kernel';
