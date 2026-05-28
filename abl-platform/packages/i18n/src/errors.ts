import type { ErrorCode, ErrorResponse, MessageParams } from './types.js';
import { formatMessage } from './format-message.js';

/**
 * Platform error catalog. English source-of-truth templates.
 * Each value is an ICU MessageFormat template.
 */
export const ErrorCatalog = {
  // Authentication
  AUTH_MISSING_HEADER: 'Authentication header is required',
  AUTH_MISSING_PUBLIC_KEY: 'Missing X-Public-Key header',
  AUTH_INVALID_KEY: 'The API key is invalid or expired',
  AUTH_INVALID_KEY_FORMAT: 'Invalid key format \u2014 expected pk_* prefix',
  AUTH_INVALID_TOKEN: 'The authentication token is invalid or expired',
  AUTH_INVALID_SDK_TOKEN: 'Invalid or expired SDK session token',
  AUTH_ORIGIN_BLOCKED: 'Requests from {origin} are not allowed',
  AUTH_INSUFFICIENT_PERMISSIONS: 'You do not have permission to access this resource',
  AUTH_FORBIDDEN: 'Forbidden',
  AUTH_REQUIRED: 'Authentication required',
  AUTH_USER_NOT_FOUND: 'User not found',
  AUTH_NOT_TENANT_MEMBER: 'Not a member of this tenant',
  AUTH_PROJECT_ID_REQUIRED: 'Project ID required',
  AUTH_USER_IDENTITY_REQUIRED: 'User identity required',
  AUTH_NOT_PROJECT_MEMBER: 'You are not a member of this project',
  AUTH_REQUIRES_AUTH_TYPE: 'This endpoint requires {authTypes} authentication',
  AUTH_REQUIRES_PLATFORM_ADMIN: 'This endpoint requires platform administrator access',
  AUTH_API_KEY_PROJECT_DENIED: 'API key does not have access to this project',
  AUTH_API_KEY_ENV_DENIED: 'API key does not have access to this environment',
  AUTH_IP_ALLOWLIST_DENIED: 'Access denied: IP address not in platform admin allowlist',
  AUTH_DATABASE_UNAVAILABLE: 'Database unavailable for key validation',
  AUTH_PROJECT_NO_TENANT: 'Project has no associated tenant',
  AUTH_DEV_LOGIN_PROD: 'Dev login not available in production',
  AUTH_RATE_LIMIT: 'Rate limit exceeded',

  // Tenant & Project
  TENANT_REQUIRED: 'A tenant context is required for this operation',
  TENANT_ACCESS_DENIED: 'Tenant access denied',
  PROJECT_NOT_FOUND: 'Project {projectId} was not found',
  PROJECT_NOT_ACCESSIBLE: 'You do not have access to project {projectId}',

  // Validation
  VALIDATION_FAILED: 'Validation failed',
  FIELD_REQUIRED: '{field} is required',
  FIELD_INVALID_FORMAT: '{field} has an invalid format',

  // Runtime
  INTERNAL_SERVER_ERROR: 'An internal server error occurred',
  INVALID_REQUEST: 'Invalid request',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable',
  DATABASE_UNAVAILABLE: 'Database not available',
  SESSION_NOT_FOUND: 'Session {sessionId} was not found',

  // Compilation
  COMPILATION_FAILED: 'ABL compilation failed',

  // Lookup tables
  LOOKUP_TABLE_NOT_FOUND: "Lookup table '{tableName}' not found",
  LOOKUP_VALUE_INVALID: "'{value}' is not a valid value for {fieldName}",
  LOOKUP_API_TIMEOUT: "Lookup API timed out for table '{tableName}' after {timeoutMs}ms",
  LOOKUP_API_CIRCUIT_OPEN: "Lookup API circuit breaker open for endpoint '{endpoint}'",
  LOOKUP_UPLOAD_TOO_LARGE: 'Upload exceeds maximum size of {maxBytes} bytes',
  LOOKUP_UPLOAD_TOO_MANY_VALUES: 'Upload contains {count} values, maximum is {maxValues}',
  LOOKUP_INVALID_TABLE_NAME:
    "Invalid lookup table name '{tableName}': must be lowercase alphanumeric with underscores",
  LOOKUP_INVALID_FIELD_NAME:
    "Invalid field name '{fieldName}': must be alphanumeric with underscores/dots",

  // Guardrails
  GUARDRAIL_INPUT_BLOCKED: 'Input blocked by guardrail policy.',
  GUARDRAIL_POLICY_BLOCKED: 'Blocked by policy guardrail.',
  GUARDRAIL_TOOL_INPUT_BLOCKED: 'Tool input blocked by guardrail',
  GUARDRAIL_TOOL_OUTPUT_BLOCKED: 'Tool output blocked by guardrail',
  GUARDRAIL_HANDOFF_BLOCKED: 'Handoff blocked by guardrail',
  GUARDRAIL_STREAM_TERMINATED: 'Streaming guardrail terminated output',
  GUARDRAIL_MESSAGE_UNPROCESSABLE: 'Your message could not be processed. Please try again.',
  GUARDRAIL_EVALUATOR_UNAVAILABLE: 'Guardrail evaluator unavailable',
  GUARDRAIL_EVAL_FAILED: 'Guardrail evaluation failed',
  GUARDRAIL_PROVIDER_NOT_REGISTERED: 'Guardrail provider "{provider}" not registered',
  GUARDRAIL_FILTER_ESCALATED: 'Filter removed too much content from "{guardrailName}" — blocked',
} as const satisfies Record<string, string>;

export type ErrorCodeType = keyof typeof ErrorCatalog;

/**
 * Synchronous error formatting using English catalog.
 * For use in middleware where async locale file loading is impractical.
 */
export function formatErrorSync(code: ErrorCode, params?: MessageParams): ErrorResponse {
  const template = (ErrorCatalog as Record<string, string>)[code] ?? code;
  return {
    code,
    message: formatMessage(template, params, 'en'),
  };
}
