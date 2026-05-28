import { describe, expect, it } from 'vitest';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { classifyExecutionConfigurationDiagnostic } from '../configuration-diagnostics.js';

describe('classifyExecutionConfigurationDiagnostic', () => {
  it('does not leak tenant ids or internal model details when no model is configured', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new AppError(
        "No model configured for tenant 'tenant-dev'. Configure a TenantModel with an active connection for this tenant. (resolution errors: Agent model: failed to resolve model 'gpt-4.1-internal-preview')",
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      ),
    );

    expect(diagnostic).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_MODEL_NOT_CONFIGURED',
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
      bannerEligible: true,
    });
  });

  it('classifies provider resolution failures with canonical safe copy', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new AppError(
        "Cannot determine provider for model 'gpt-4.1-internal-preview'. Use 'provider/model' format (e.g. 'qwen/qwen35-a3b-35b') or configure a TenantModel for tenant 'tenant-dev'.",
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      ),
    );

    expect(diagnostic).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_PROVIDER_CONFIGURATION_INVALID',
      message:
        'AI model configuration is invalid for this workspace. Ask your workspace administrator to review the configured model provider.',
      bannerEligible: true,
    });
  });

  it('classifies provider stopReason error results as wiring failures with safe copy', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new AppError(
        'LLM provider returned stopReason "error" for provider "openai" and model "gpt-4.1-prod-internal".',
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      ),
    );

    expect(diagnostic).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_WIRING_FAILED',
      message:
        'The model provider returned an error before producing a response. Check provider credentials and model configuration.',
      bannerEligible: true,
    });
  });
});
