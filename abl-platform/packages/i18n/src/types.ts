/**
 * BCP 47 locale code: 'en', 'ar', 'de', 'pt-BR', 'zh-Hans', etc.
 */
export type Locale = string;

/**
 * Platform error code from the error catalog.
 */
export type ErrorCode = string;

/**
 * ICU MessageFormat parameters.
 */
export interface MessageParams {
  [key: string]: string | number | boolean;
}

/**
 * Structured error response returned by all API endpoints.
 */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Structured validation error response.
 */
export interface ValidationErrorResponse {
  code: 'VALIDATION_FAILED';
  errors: Array<{
    field: string;
    code: string;
    message: string;
  }>;
}
