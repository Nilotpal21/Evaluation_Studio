import {
  AppError,
  ErrorCodes,
  ToolExecutionError,
  type ToolErrorCode,
} from '@agent-platform/shared-kernel';
import type { CanonicalConfigurationCode } from '../diagnostics/configuration-taxonomy.js';
import { getModelResolutionConfigurationFailure } from '../llm/model-resolution-errors.js';

export interface ExecutionConfigurationDiagnostic {
  category: 'llm' | 'tool';
  severity: 'info' | 'warning' | 'error';
  code: Extract<
    CanonicalConfigurationCode,
    | 'LLM_CREDENTIAL_MISSING'
    | 'LLM_MODEL_NOT_CONFIGURED'
    | 'LLM_PROVIDER_CONFIGURATION_INVALID'
    | 'LLM_WIRING_FAILED'
    | 'TOOL_CODE_EXECUTION_DISABLED'
  >;
  message: string;
  bannerEligible: boolean;
}

const MISSING_CREDENTIAL_PATTERN = /No credential found for provider '([^']+)'/i;
const LLM_WIRING_FAILED_PATTERN = /Session LLM client not configured/i;
const LLM_STOP_REASON_ERROR_PATTERN = /LLM provider returned stopReason "error"/i;
const CODE_TOOL_DISABLED_PATTERN = /Code tool execution is disabled for this workspace/i;
const CODE_TOOL_DISABLED_MESSAGE =
  'Code tool execution is disabled for this workspace. Enable code tools in workspace settings to run sandbox tools.';

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getToolExecutionErrorMetadata(error: unknown): {
  code?: ToolErrorCode;
  retryable?: boolean;
} {
  if (error instanceof ToolExecutionError) {
    return { code: error.code, retryable: error.retryable };
  }

  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const candidate = error as { code?: unknown; retryable?: unknown };
  const code =
    typeof candidate.code === 'string' && candidate.code.startsWith('TOOL_')
      ? (candidate.code as ToolErrorCode)
      : undefined;

  return {
    code,
    retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : undefined,
  };
}

export function classifyExecutionConfigurationDiagnostic(
  error: unknown,
): ExecutionConfigurationDiagnostic | undefined {
  const message = normalizeErrorMessage(error);
  const { code: toolErrorCode } = getToolExecutionErrorMetadata(error);

  if (
    toolErrorCode === 'TOOL_CODE_EXECUTION_DISABLED' ||
    CODE_TOOL_DISABLED_PATTERN.test(message)
  ) {
    return {
      category: 'tool',
      severity: 'error',
      code: 'TOOL_CODE_EXECUTION_DISABLED',
      message: CODE_TOOL_DISABLED_MESSAGE,
      bannerEligible: true,
    };
  }

  if (
    error instanceof AppError &&
    error.code === ErrorCodes.CREDENTIAL_NOT_FOUND.code &&
    message.trim().length > 0
  ) {
    return {
      category: 'llm',
      severity: 'error',
      code: 'LLM_CREDENTIAL_MISSING',
      message,
      bannerEligible: true,
    };
  }

  if (MISSING_CREDENTIAL_PATTERN.test(message)) {
    return {
      category: 'llm',
      severity: 'error',
      code: 'LLM_CREDENTIAL_MISSING',
      message,
      bannerEligible: true,
    };
  }

  const modelResolutionFailure = getModelResolutionConfigurationFailure(error);
  if (modelResolutionFailure) {
    return {
      category: 'llm',
      severity: 'error',
      code: modelResolutionFailure.code,
      message: modelResolutionFailure.message,
      bannerEligible: true,
    };
  }

  if (LLM_WIRING_FAILED_PATTERN.test(message)) {
    return {
      category: 'llm',
      severity: 'error',
      code: 'LLM_WIRING_FAILED',
      message,
      bannerEligible: true,
    };
  }

  if (LLM_STOP_REASON_ERROR_PATTERN.test(message)) {
    return {
      category: 'llm',
      severity: 'error',
      code: 'LLM_WIRING_FAILED',
      message:
        'The model provider returned an error before producing a response. Check provider credentials and model configuration.',
      bannerEligible: true,
    };
  }

  return undefined;
}
