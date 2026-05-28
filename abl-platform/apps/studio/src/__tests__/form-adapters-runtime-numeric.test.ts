import { describe, expect, it } from 'vitest';
import {
  httpConfigToToolForm,
  sandboxConfigToToolForm,
  toolFormToHttpConfig,
  toolFormToSandboxConfig,
} from '../components/tools/form-adapters';
import type { HttpToolFormData, SandboxToolFormData } from '@agent-platform/shared/types';

describe('tool form adapters runtime numeric placeholders', () => {
  it('preserves HTTP config numeric placeholders when saving unrelated edits', () => {
    const existing: HttpToolFormData = {
      name: 'configured_api',
      toolType: 'http',
      description: 'Configured API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: '{{config.HTTP_RETRY_COUNT}}',
      retryDelay: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimit: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    };

    const uiConfig = toolFormToHttpConfig(existing);
    expect(uiConfig).toMatchObject({
      timeoutMs: '{{config.HTTP_TIMEOUT_MS}}',
      retryCount: '{{config.HTTP_RETRY_COUNT}}',
      retryDelayMs: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimitPerMinute: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    });

    const saved = httpConfigToToolForm('configured_api', 'Renamed', uiConfig, existing);

    expect(saved.timeout).toBe('{{config.HTTP_TIMEOUT_MS}}');
    expect(saved.retry).toBe('{{config.HTTP_RETRY_COUNT}}');
    expect(saved.retryDelay).toBe('{{config.HTTP_RETRY_DELAY_MS}}');
    expect(saved.rateLimit).toBe('{{config.HTTP_RATE_LIMIT}}');
    expect(saved.circuitBreaker).toEqual(existing.circuitBreaker);
  });

  it('preserves sandbox config numeric placeholders when saving unrelated edits', () => {
    const existing: SandboxToolFormData = {
      name: 'configured_sandbox',
      toolType: 'sandbox',
      description: 'Configured sandbox',
      parameters: [],
      returnType: 'object',
      runtime: 'python',
      code: 'print("hello")',
      memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
      timeout: '{{config.SANDBOX_TIMEOUT_MS}}',
    };

    const uiConfig = toolFormToSandboxConfig(existing);
    expect(uiConfig).toMatchObject({
      memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
      timeoutMs: '{{config.SANDBOX_TIMEOUT_MS}}',
    });

    const saved = sandboxConfigToToolForm('configured_sandbox', 'Renamed', uiConfig, existing);

    expect(saved.memoryMb).toBe('{{config.SANDBOX_MEMORY_MB}}');
    expect(saved.timeout).toBe('{{config.SANDBOX_TIMEOUT_MS}}');
  });

  it('persists intentional HTTP numeric edits from placeholders to numbers and back', () => {
    const existing: HttpToolFormData = {
      name: 'configured_api',
      toolType: 'http',
      description: 'Configured API',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: 1,
    };

    const numericEdit = httpConfigToToolForm(
      'configured_api',
      'Configured API',
      {
        ...toolFormToHttpConfig(existing),
        timeoutMs: 45000,
        retryCount: '{{config.HTTP_RETRY_COUNT}}',
      },
      existing,
    );

    expect(numericEdit.timeout).toBe(45000);
    expect(numericEdit.retry).toBe('{{config.HTTP_RETRY_COUNT}}');
  });

  it('persists intentional sandbox numeric edits from placeholders to numbers and back', () => {
    const existing: SandboxToolFormData = {
      name: 'configured_sandbox',
      toolType: 'sandbox',
      description: 'Configured sandbox',
      parameters: [],
      returnType: 'object',
      runtime: 'python',
      code: 'print("hello")',
      memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
      timeout: 5000,
    };

    const saved = sandboxConfigToToolForm(
      'configured_sandbox',
      'Configured sandbox',
      {
        ...toolFormToSandboxConfig(existing),
        memoryMb: 256,
        timeoutMs: '{{config.SANDBOX_TIMEOUT_MS}}',
      },
      existing,
    );

    expect(saved.memoryMb).toBe(256);
    expect(saved.timeout).toBe('{{config.SANDBOX_TIMEOUT_MS}}');
  });
});
