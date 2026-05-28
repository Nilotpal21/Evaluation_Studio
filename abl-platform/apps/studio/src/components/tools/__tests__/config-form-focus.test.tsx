import React, { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../store/mcp-server-store', () => ({
  useMcpServerStore: () => ({
    servers: [],
  }),
}));

import { HttpConfigForm, type HttpConfig } from '../HttpConfigForm';
import { McpConfigForm, type McpConfig } from '../McpConfigForm';

function normalizeCustomHeaders(
  raw: Record<string, string> | string | undefined,
): Record<string, string> {
  if (!raw) return {};

  // Handle legacy JSON-string format
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      return {};
    }
    return {};
  }

  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

function reorderCustomHeadersByInitialOrder(
  headers: Record<string, string> | string | undefined,
  initialOrder: string[],
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const parsed = normalizeCustomHeaders(headers);
  const orderedEntries: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const key of initialOrder) {
    if (!(key in parsed)) continue;
    orderedEntries.push([key, parsed[key]]);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (seen.has(key)) continue;
    orderedEntries.push([key, value]);
  }

  return Object.fromEntries(orderedEntries);
}

function HttpConfigHarness({ initialConfig }: { initialConfig: HttpConfig }) {
  const [config, setConfig] = useState(initialConfig);
  return <HttpConfigForm config={config} onChange={setConfig} showTemplates={false} />;
}

function McpConfigHarness({ initialConfig }: { initialConfig: McpConfig }) {
  const [config, setConfig] = useState(initialConfig);
  return <McpConfigForm config={config} onChange={setConfig} />;
}

function ToolDetailHttpConfigHarness({ initialConfig }: { initialConfig: HttpConfig }) {
  const initialConfigRef = useRef(initialConfig);
  const [config, setConfig] = useState(initialConfig);
  const isDirty = JSON.stringify(config) !== JSON.stringify(initialConfigRef.current);
  const initialCustomHeaderOrderRef = useRef(
    Object.keys(normalizeCustomHeaders(initialConfig.authConfig?.customHeaders)),
  );

  return (
    <div>
      <div data-testid="tool-detail-dirty-state">{isDirty ? 'dirty' : 'clean'}</div>
      <HttpConfigForm
        config={config}
        onChange={(nextConfig) => {
          const clonedConfig = JSON.parse(JSON.stringify(nextConfig)) as HttpConfig;
          if (clonedConfig.authConfig?.customHeaders) {
            const reordered = reorderCustomHeadersByInitialOrder(
              clonedConfig.authConfig.customHeaders,
              initialCustomHeaderOrderRef.current,
            );
            if (reordered) clonedConfig.authConfig.customHeaders = reordered;
          }
          setConfig(clonedConfig);
        }}
        showTemplates={false}
      />
    </div>
  );
}

describe('tool config form focus handling', () => {
  it('keeps focus while typing in HTTP query param and header fields', async () => {
    const user = userEvent.setup();

    render(
      <HttpConfigHarness
        initialConfig={{
          endpoint: 'https://api.example.com',
          method: 'GET',
          authType: 'none',
          queryParams: [{ key: 'tenant_id', value: 'tenant-1' }],
          headers: [{ key: 'X-Trace', value: 'trace-1' }],
        }}
      />,
    );

    const queryParamInput = screen.getByDisplayValue('tenant_id');
    await user.click(queryParamInput);
    await user.keyboard('a');
    await waitFor(() => expect(screen.getByDisplayValue('tenant_ida')).toHaveFocus());
    await user.keyboard('b');
    await waitFor(() => expect(screen.getByDisplayValue('tenant_idab')).toHaveFocus());

    const headerInput = screen.getByDisplayValue('X-Trace');
    await user.click(headerInput);
    await user.keyboard('A');
    await waitFor(() => expect(screen.getByDisplayValue('X-TraceA')).toHaveFocus());
    await user.keyboard('B');
    await waitFor(() => expect(screen.getByDisplayValue('X-TraceAB')).toHaveFocus());
  });

  it('keeps focus while typing in HTTP custom auth headers', async () => {
    const user = userEvent.setup();

    render(
      <HttpConfigHarness
        initialConfig={{
          endpoint: 'https://api.example.com',
          method: 'GET',
          authType: 'custom',
          authConfig: {
            customHeaders: {
              'X-Auth': '{{secrets.AUTH_TOKEN}}',
              'X-Tenant': '{{secrets.TENANT_TOKEN}}',
            },
          },
        }}
      />,
    );

    const customHeaderNameInput = screen.getByDisplayValue('X-Auth');
    await user.click(customHeaderNameInput);
    await user.keyboard('a');
    await waitFor(() => {
      const updatedCustomHeaderNameInput = screen.getByDisplayValue('X-Autha');
      expect(updatedCustomHeaderNameInput).toBe(customHeaderNameInput);
      expect(updatedCustomHeaderNameInput).toHaveFocus();
    });
    await user.keyboard('b');
    await waitFor(() => {
      const updatedCustomHeaderNameInput = screen.getByDisplayValue('X-Authab');
      expect(updatedCustomHeaderNameInput).toBe(customHeaderNameInput);
      expect(updatedCustomHeaderNameInput).toHaveFocus();
    });

    const customHeaderValueInput = screen.getByDisplayValue('{{secrets.AUTH_TOKEN}}');
    await user.click(customHeaderValueInput);
    await user.keyboard('_');
    await waitFor(() => {
      const updatedCustomHeaderValueInput = screen.getByDisplayValue('{{secrets.AUTH_TOKEN}}_');
      expect(updatedCustomHeaderValueInput).toBe(customHeaderValueInput);
      expect(updatedCustomHeaderValueInput).toHaveFocus();
    });
    await user.keyboard('2');
    await waitFor(() => {
      const updatedCustomHeaderValueInput = screen.getByDisplayValue('{{secrets.AUTH_TOKEN}}_2');
      expect(updatedCustomHeaderValueInput).toBe(customHeaderValueInput);
      expect(updatedCustomHeaderValueInput).toHaveFocus();
    });
  });

  it('keeps custom auth header focus through tool detail page state updates', async () => {
    const user = userEvent.setup();

    render(
      <ToolDetailHttpConfigHarness
        initialConfig={{
          endpoint: 'https://api.example.com',
          method: 'GET',
          authType: 'custom',
          authConfig: {
            customHeaders: {
              'X-Auth': '{{secrets.AUTH_TOKEN}}',
              'X-Tenant': '{{secrets.TENANT_TOKEN}}',
            },
          },
        }}
      />,
    );

    const customHeaderNameInput = screen.getByDisplayValue('X-Auth');
    expect(screen.getByTestId('tool-detail-dirty-state')).toHaveTextContent('clean');

    await user.click(customHeaderNameInput);
    await user.keyboard('a');

    await waitFor(() => {
      const updatedCustomHeaderNameInput = screen.getByDisplayValue('X-Autha');
      expect(updatedCustomHeaderNameInput).toBe(customHeaderNameInput);
      expect(updatedCustomHeaderNameInput).toHaveFocus();
      expect(screen.getByTestId('tool-detail-dirty-state')).toHaveTextContent('dirty');
    });

    await user.keyboard('b');

    await waitFor(() => {
      const updatedCustomHeaderNameInput = screen.getByDisplayValue('X-Authab');
      expect(updatedCustomHeaderNameInput).toBe(customHeaderNameInput);
      expect(updatedCustomHeaderNameInput).toHaveFocus();
    });
  });

  it('keeps focus while typing in MCP header fields', async () => {
    const user = userEvent.setup();

    render(
      <McpConfigHarness
        initialConfig={{
          serverUrl: 'demo-mcp',
          transportType: 'sse',
          headers: [{ key: 'X-MCP-Header', value: 'value-1' }],
          serverToolName: '',
        }}
      />,
    );

    const mcpHeaderInput = screen.getByDisplayValue('X-MCP-Header');
    await user.click(mcpHeaderInput);
    await user.keyboard('a');
    await waitFor(() => expect(screen.getByDisplayValue('X-MCP-Headera')).toHaveFocus());
    await user.keyboard('b');
    await waitFor(() => expect(screen.getByDisplayValue('X-MCP-Headerab')).toHaveFocus());
  });
});
