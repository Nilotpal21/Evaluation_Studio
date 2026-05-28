import { describe, expect, it } from 'vitest';
import { AppError, ErrorCodes, ToolExecutionError } from '@agent-platform/shared-kernel';
import { classifyExecutionConfigurationDiagnostic } from '../../services/execution/configuration-diagnostics.js';

describe('classifyExecutionConfigurationDiagnostic', () => {
  it('classifies missing credential errors from model resolution messages', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new AppError(
        "No credential found for provider 'openai' in tenant 'tenant-dev'. Configure a TenantModel with a connection or add an LLMCredential.",
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      ),
    );

    expect(diagnostic).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_CREDENTIAL_MISSING',
      message:
        "No credential found for provider 'openai' in tenant 'tenant-dev'. Configure a TenantModel with a connection or add an LLMCredential.",
      bannerEligible: true,
    });
  });

  it('classifies missing model configuration errors without leaking tenant internals', () => {
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

  it('classifies provider configuration errors without leaking tenant or model details', () => {
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

  it('classifies LLM wiring failures', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new AppError('Session LLM client not configured', { ...ErrorCodes.SERVICE_UNAVAILABLE }),
    );

    expect(diagnostic?.code).toBe('LLM_WIRING_FAILED');
  });

  it('classifies disabled code tools as a tool configuration error', () => {
    const diagnostic = classifyExecutionConfigurationDiagnostic(
      new ToolExecutionError({
        code: 'TOOL_CODE_EXECUTION_DISABLED',
        message: 'Code tool execution is disabled for this workspace',
        toolName: 'search_hotels',
        toolType: 'sandbox',
      }),
    );

    expect(diagnostic).toEqual({
      category: 'tool',
      severity: 'error',
      code: 'TOOL_CODE_EXECUTION_DISABLED',
      message:
        'Code tool execution is disabled for this workspace. Enable code tools in workspace settings to run sandbox tools.',
      bannerEligible: true,
    });
  });

  it('ignores unrelated execution errors', () => {
    expect(
      classifyExecutionConfigurationDiagnostic(new Error('Calendar lookup failed')),
    ).toBeUndefined();
  });
});
