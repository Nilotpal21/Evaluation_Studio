import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

export type ModelResolutionConfigurationCode =
  | 'LLM_MODEL_NOT_CONFIGURED'
  | 'LLM_PROVIDER_CONFIGURATION_INVALID';

export interface ModelResolutionConfigurationFailure {
  code: ModelResolutionConfigurationCode;
  message: string;
}

const RAW_MODEL_NOT_CONFIGURED_PATTERN = /\bNo model configured\b/i;
const RAW_PROVIDER_CONFIGURATION_INVALID_PATTERN = /\bCannot determine provider for model\b/i;

export const MODEL_NOT_CONFIGURED_MESSAGE =
  'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.';
export const MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE =
  'AI model configuration is invalid for this workspace. Ask your workspace administrator to review the configured model provider.';

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getUserSafeMessage(code: ModelResolutionConfigurationCode): string {
  return code === 'LLM_PROVIDER_CONFIGURATION_INVALID'
    ? MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE
    : MODEL_NOT_CONFIGURED_MESSAGE;
}

export function getModelResolutionConfigurationFailure(
  error: unknown,
): ModelResolutionConfigurationFailure | undefined {
  const message = normalizeErrorMessage(error);

  if (
    RAW_PROVIDER_CONFIGURATION_INVALID_PATTERN.test(message) ||
    (error instanceof AppError &&
      error.code === ErrorCodes.MODEL_NOT_CONFIGURED.code &&
      message === MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE)
  ) {
    return {
      code: 'LLM_PROVIDER_CONFIGURATION_INVALID',
      message: MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE,
    };
  }

  if (
    RAW_MODEL_NOT_CONFIGURED_PATTERN.test(message) ||
    (error instanceof AppError && error.code === ErrorCodes.MODEL_NOT_CONFIGURED.code)
  ) {
    return {
      code: 'LLM_MODEL_NOT_CONFIGURED',
      message: MODEL_NOT_CONFIGURED_MESSAGE,
    };
  }

  return undefined;
}

export function createModelResolutionConfigurationError(
  code: ModelResolutionConfigurationCode,
  opts?: { cause?: unknown },
): AppError {
  return new AppError(getUserSafeMessage(code), {
    ...ErrorCodes.MODEL_NOT_CONFIGURED,
    cause: opts?.cause,
  });
}

export function toUserSafeModelResolutionConfigurationError(error: unknown): AppError | undefined {
  const failure = getModelResolutionConfigurationFailure(error);
  if (!failure) {
    return undefined;
  }

  if (
    error instanceof AppError &&
    error.code === ErrorCodes.MODEL_NOT_CONFIGURED.code &&
    error.message === failure.message
  ) {
    return error;
  }

  return createModelResolutionConfigurationError(failure.code, { cause: error });
}
