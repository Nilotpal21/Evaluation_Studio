/**
 * McpConfigForm Validation Tests
 *
 * Tests validateMcpConfig which validates MCP server configuration.
 * The server field references a registered MCP server name, not a raw URL.
 */

import { describe, test, expect } from 'vitest';
import { validateMcpConfig } from '../McpConfigForm';
import type { McpConfig } from '../McpConfigForm';

// =============================================================================
// REQUIRED FIELD VALIDATION
// =============================================================================

describe('validateMcpConfig - Required Fields', () => {
  test('accepts any non-empty server reference (no URL validation)', () => {
    // After MCP server refactor, serverUrl holds a server name reference,
    // not a raw URL. SSRF validation is handled at the server registration level.
    const configs = [
      'file:///etc/passwd',
      'gopher://malicious.com:25/xHELO',
      'dict://localhost:11211/stat',
      'http://mcp-server.example.com/sse',
      'https://mcp-server.example.com/sse',
      'ftp://files.example.com/data',
      'not-a-valid-url',
      'my-mcp-server',
    ];
    for (const serverUrl of configs) {
      const errors = validateMcpConfig({
        serverUrl,
        transportType: 'sse',
        headers: [],
        serverToolName: '',
      });
      expect(errors.serverUrl).toBeUndefined();
    }
  });

  test('requires server URL to be non-empty', () => {
    const config: McpConfig = {
      serverUrl: '',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(errors.serverUrl).toBeDefined();
    expect(errors.serverUrl).toContain('required');
  });
});

// =============================================================================
// BASIC VALIDATION TESTS
// =============================================================================

describe('validateMcpConfig - Basic Validation', () => {
  test('validates minimal valid config', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('allows serverToolName to be empty (optional field)', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(errors.serverToolName).toBeUndefined();
  });

  test('accepts custom serverToolName', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [],
      serverToolName: 'custom_tool_name',
    };
    const errors = validateMcpConfig(config);
    expect(errors.serverToolName).toBeUndefined();
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('validateMcpConfig - Edge Cases', () => {
  test('handles URL with query parameters and fragments', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com/sse?param=value#section',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(errors.serverUrl).toBeUndefined();
  });

  test('handles URL with port number', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com:8443/sse',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(errors.serverUrl).toBeUndefined();
  });
});

// =============================================================================
// TRANSPORT TYPE VARIANTS
// =============================================================================

describe('validateMcpConfig - Transport Types', () => {
  test('validates SSE transport type', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com/sse',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('validates HTTP transport type', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com/http',
      transportType: 'http',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('validates config with headers array', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [
        { key: 'X-Custom-Header', value: 'custom-value' },
        { key: 'Authorization', value: 'Bearer token' },
      ],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  test('validates config with empty headers array', () => {
    const config: McpConfig = {
      serverUrl: 'https://mcp.example.com',
      transportType: 'sse',
      headers: [],
      serverToolName: '',
    };
    const errors = validateMcpConfig(config);
    expect(Object.keys(errors)).toHaveLength(0);
  });
});
