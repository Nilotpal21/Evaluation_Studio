/**
 * Mock MCP server for E2E functional tests.
 * Exposes a lookup_order tool that returns canned order data.
 *
 * This file is designed to run as a standalone process (stdio transport)
 * so the runtime can connect to it via MCP stdio protocol.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'e2e-mock-mcp',
  version: '1.0.0',
});

server.tool(
  'lookup_order',
  'Look up an order by ID and return its status',
  { orderId: z.string().describe('The order ID to look up') },
  async ({ orderId }) => {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            orderId,
            status: 'shipped',
            eta: '2026-03-20',
            carrier: 'FedEx',
          }),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
