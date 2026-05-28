#!/usr/bin/env tsx
/**
 * Test MCP Server
 *
 * A proper SSE-based MCP server for testing MCP tool integration.
 * Responses are sent via the SSE stream, not as HTTP responses.
 */

import express from 'express';
import type { Response } from 'express';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('test-mcp-server');
const app = express();
const PORT = 5678;

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

const TOOLS: MCPTool[] = [
  {
    name: 'get_system_info',
    description: 'Get basic system information',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'echo',
    description: 'Echo back the provided message',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to echo back',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_timestamp',
    description: 'Get current timestamp',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Track SSE connections
const sseClients: Response[] = [];

// SSE endpoint
app.get('/sse', (req, res) => {
  log.info('Client connected to SSE');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Add client to list
  sseClients.push(res);

  // Send initial endpoint message
  res.write(`event: endpoint\n`);
  res.write(`data: http://localhost:${PORT}/message\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const idx = sseClients.indexOf(res);
    if (idx !== -1) {
      sseClients.splice(idx, 1);
    }
    log.info('Client disconnected from SSE');
  });
});

// Helper to send JSON-RPC response via SSE
function sendSseResponse(response: any) {
  const data = JSON.stringify(response);
  log.info('Sending SSE response', {
    id: response.id,
    method: response.result ? 'success' : 'error',
  });

  // Send to all connected clients
  for (const client of sseClients) {
    try {
      client.write(`event: message\n`);
      client.write(`data: ${data}\n\n`);
    } catch (e) {
      log.warn('Failed to send to client', { error: e });
    }
  }
}

// Message endpoint for RPC calls
app.use(express.json());
app.post('/message', (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  log.info('Received RPC call', { method, id, params });

  // Acknowledge receipt immediately (HTTP 200, empty body)
  res.status(200).end();

  let response: any;

  // Initialize
  if (method === 'initialize') {
    response = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '1.0',
        serverInfo: {
          name: 'test-mcp-server',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
        },
      },
    };
    sendSseResponse(response);
    return;
  }

  // List tools
  if (method === 'tools/list') {
    response = {
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS,
      },
    };
    sendSseResponse(response);
    return;
  }

  // Call tool
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;

    if (name === 'get_system_info') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  platform: process.platform,
                  arch: process.arch,
                  nodeVersion: process.version,
                  uptime: process.uptime(),
                  memory: process.memoryUsage(),
                },
                null,
                2,
              ),
            },
          ],
        },
      };
      sendSseResponse(response);
      return;
    }

    if (name === 'echo') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: args.message || 'No message provided',
            },
          ],
        },
      };
      sendSseResponse(response);
      return;
    }

    if (name === 'get_timestamp') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: new Date().toISOString(),
            },
          ],
        },
      };
      sendSseResponse(response);
      return;
    }

    // Unknown tool
    response = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Tool not found: ${name}`,
      },
    };
    sendSseResponse(response);
    return;
  }

  // Unknown method
  response = {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
  sendSseResponse(response);
});

app.listen(PORT, () => {
  log.info(`Test MCP server running on http://localhost:${PORT}`);
  log.info(`SSE endpoint: http://localhost:${PORT}/sse`);
  log.info(`Message endpoint: http://localhost:${PORT}/message`);
  log.info(`Available tools: ${TOOLS.map((t) => t.name).join(', ')}`);
});
