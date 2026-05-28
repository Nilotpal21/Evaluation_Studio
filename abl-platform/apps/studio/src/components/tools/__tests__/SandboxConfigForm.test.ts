/**
 * SandboxConfigForm Validation Tests
 *
 * CRITICAL SECURITY TESTS: Code injection prevention, size limits, parameter validation
 * These tests ensure that sandbox code execution is safe and within resource bounds.
 */

import { describe, test, expect } from 'vitest';
import { validateSandboxConfig } from '../SandboxConfigForm';
import type { SandboxConfig } from '../SandboxConfigForm';

// =============================================================================
// CRITICAL: CODE INJECTION PREVENTION & RESOURCE LIMITS
// =============================================================================

describe('validateSandboxConfig - Code Injection Prevention', () => {
  test('enforces code size limit of 256KB', () => {
    const largeCode = 'x'.repeat(300 * 1024); // 300KB - exceeds limit
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: largeCode,
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.codeContent).toBeDefined();
    expect(errors.codeContent).toContain('256KB');
  });

  test('accepts code within 256KB limit', () => {
    const acceptableCode = 'x'.repeat(200 * 1024); // 200KB - within limit
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: acceptableCode,
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.codeContent).toBeUndefined();
  });

  test('enforces memory limit of 512MB', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("test")',
      memoryMb: 1024, // Exceeds 512MB limit
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.memoryMb).toBeDefined();
    expect(errors.memoryMb).toContain('512MB');
  });

  test('accepts memory within 512MB limit', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("test")',
      memoryMb: 256,
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.memoryMb).toBeUndefined();
  });

  test('accepts exact config templates for memory and timeout', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("test")',
      memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
      timeoutMs: '{{config.SANDBOX_TIMEOUT_MS}}',
      parameters: [],
    };

    const errors = validateSandboxConfig(config);

    expect(errors.memoryMb).toBeUndefined();
    expect(errors.timeoutMs).toBeUndefined();
  });

  test('rejects non-exact config expressions for memory and timeout', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("test")',
      memoryMb: 'size-{{config.SANDBOX_MEMORY_MB}}' as SandboxConfig['memoryMb'],
      timeoutMs: 'timeout-{{config.SANDBOX_TIMEOUT_MS}}' as SandboxConfig['timeoutMs'],
      parameters: [],
    };

    const errors = validateSandboxConfig(config);

    expect(errors.memoryMb).toContain('{{config.KEY}}');
    expect(errors.timeoutMs).toContain('{{config.KEY}}');
  });

  test('requires code content to be non-empty', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: '',
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.codeContent).toBeDefined();
    expect(errors.codeContent).toContain('required');
  });

  test('rejects code that is only whitespace', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: '   \n\t  ',
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.codeContent).toBeDefined();
    expect(errors.codeContent).toContain('required');
  });

  test('requires runtime to be specified', () => {
    // Intentionally invalid config to test validation
    const config: SandboxConfig = {
      runtime: '' as SandboxConfig['runtime'],
      codeContent: 'console.log("test")',
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.runtime).toBeDefined();
    expect(errors.runtime).toContain('required');
  });
});

// =============================================================================
// PARAMETER NAME VALIDATION (Prevent Injection via Parameter Names)
// =============================================================================

describe('validateSandboxConfig - Parameter Name Validation', () => {
  test('accepts valid parameter names', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'def main(user_id): return user_id',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: 'User identifier',
          required: true,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });

  test('accepts parameter name with numbers', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'test',
      parameters: [
        {
          name: 'param_123',
          type: 'string',
          description: 'Test param',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });

  test('rejects parameter name with spaces', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user id',
          type: 'string',
          description: 'User ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('valid identifier');
  });

  test('rejects parameter name with hyphens', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user-id',
          type: 'string',
          description: 'User ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('valid identifier');
  });

  test('rejects parameter name starting with number', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: '1user',
          type: 'string',
          description: 'User',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('valid identifier');
  });

  test('accepts parameter name starting with underscore', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: '_private',
          type: 'string',
          description: 'Private var',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });

  test('accepts parameter name with camelCase', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'userId',
          type: 'string',
          description: 'User ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });

  test('rejects parameter name with special characters', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user@id',
          type: 'string',
          description: 'User ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('valid identifier');
  });

  test('rejects empty parameter name', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: '',
          type: 'string',
          description: 'Test',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('Name is required');
  });
});

// =============================================================================
// PARAMETER DESCRIPTION VALIDATION (Required for LLM Context)
// =============================================================================

describe('validateSandboxConfig - Parameter Description', () => {
  test('requires non-empty description for LLM context', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: '',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('Description is required');
  });

  test('rejects whitespace-only description', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: '   ',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('Description is required');
  });

  test('accepts valid description', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: 'The unique identifier for the user',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });
});

// =============================================================================
// ENUM VALIDATION
// =============================================================================

describe('validateSandboxConfig - Enum Parameters', () => {
  test('requires at least one enum value', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'status',
          type: 'enum',
          description: 'Status value',
          enumValues: [],
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('at least one value');
  });

  test('rejects enum with only empty/falsy values', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'status',
          type: 'enum',
          description: 'Status',
          enumValues: ['', null, undefined] as any,
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('at least one value');
  });

  test('accepts valid enum values', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'status',
          type: 'enum',
          description: 'Status',
          enumValues: ['active', 'inactive', 'pending'],
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });
});

// =============================================================================
// OBJECT SCHEMA VALIDATION
// =============================================================================

describe('validateSandboxConfig - Object Schema', () => {
  test('validates JSON format in object schema', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_data',
          type: 'object',
          description: 'User data object',
          objectSchema: '{invalid-json}',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_0).toContain('Invalid JSON');
  });

  test('accepts valid JSON object schema', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_data',
          type: 'object',
          description: 'User data',
          objectSchema: '{"name": {"type": "string"}, "age": {"type": "number"}}',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });

  test('allows object parameter without schema', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'data',
          type: 'object',
          description: 'Generic data object',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
  });
});

// =============================================================================
// DUPLICATE PARAMETER DETECTION
// =============================================================================

describe('validateSandboxConfig - Duplicate Parameters', () => {
  test('detects duplicate parameter names', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: 'First user ID',
          required: false,
        },
        {
          name: 'user_id',
          type: 'number',
          description: 'Second user ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0 || errors.param_1).toBeDefined();
    expect((errors.param_0 || errors.param_1) as string).toContain('Duplicate');
  });

  test('allows unique parameter names', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'user_id',
          type: 'string',
          description: 'User ID',
          required: false,
        },
        {
          name: 'session_id',
          type: 'string',
          description: 'Session ID',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeUndefined();
    expect(errors.param_1).toBeUndefined();
  });
});

// =============================================================================
// MULTIPLE ERROR REPORTING
// =============================================================================

describe('validateSandboxConfig - Multiple Errors', () => {
  test('reports multiple validation errors for same parameter', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: 'User-ID',
          type: 'enum',
          description: '',
          enumValues: [],
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    const errorMsg = errors.param_0 as string;
    expect(errorMsg).toContain('valid identifier');
    expect(errorMsg).toContain('Description is required');
    expect(errorMsg).toContain('at least one value');
  });

  test('reports errors across multiple parameters', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'test',
      parameters: [
        {
          name: '1invalid',
          type: 'string',
          description: 'First',
          required: false,
        },
        {
          name: 'valid_name',
          type: 'enum',
          description: '',
          enumValues: [],
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(errors.param_0).toBeDefined();
    expect(errors.param_1).toBeDefined();
  });
});

// =============================================================================
// HAPPY PATH & EDGE CASES
// =============================================================================

describe('validateSandboxConfig - Happy Path & Edge Cases', () => {
  test('validates minimal valid config', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return "test";',
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('validates complex config with all parameter types', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'def main(string_param, number_param, enum_param, object_param): pass',
      memoryMb: 256,
      parameters: [
        {
          name: 'string_param',
          type: 'string',
          description: 'A string parameter',
          required: true,
        },
        {
          name: 'number_param',
          type: 'number',
          description: 'A number parameter',
          required: false,
        },
        {
          name: 'enum_param',
          type: 'enum',
          description: 'An enum parameter',
          enumValues: ['option1', 'option2'],
          required: false,
        },
        {
          name: 'object_param',
          type: 'object',
          description: 'An object parameter',
          objectSchema: '{"key": "value"}',
          required: false,
        },
      ],
    };
    const errors = validateSandboxConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('handles config with undefined parameters array', () => {
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: 'return 42;',
      // parameters is undefined
    };
    const errors = validateSandboxConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('handles config with undefined memoryMb', () => {
    const config: SandboxConfig = {
      runtime: 'python',
      codeContent: 'print("test")',
      parameters: [],
      // memoryMb is undefined - should be fine
    };
    const errors = validateSandboxConfig(config);
    expect(errors.memoryMb).toBeUndefined();
  });

  test('validates code at exactly 256KB boundary', () => {
    const boundaryCode = 'x'.repeat(256 * 1024);
    const config: SandboxConfig = {
      runtime: 'javascript',
      codeContent: boundaryCode,
      parameters: [],
    };
    const errors = validateSandboxConfig(config);
    // At exactly 256KB, should pass (limit is >, not >=)
    expect(errors.codeContent).toBeUndefined();
  });
});
