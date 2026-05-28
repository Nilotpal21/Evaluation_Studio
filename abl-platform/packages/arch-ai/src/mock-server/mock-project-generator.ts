/**
 * Mock Project Generator — creates a Vercel-deployable mock API server.
 *
 * Adapted from v1 arch.service.ts (generateOpenAPIStub + generateMockProject).
 * Review decision: all endpoints POST, deterministic mock data, sync pipeline.
 */

import type { ToolMeta } from './tool-extractor.js';

export interface MockProjectFile {
  path: string;
  content: string;
}

export interface MockServerArtifacts {
  projectName: string;
  openApiSpec: Record<string, unknown>;
  files: MockProjectFile[];
  endpointCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

// ─── OpenAPI Spec Generation ────────────────────────────────────────────

function generateOpenAPISpec(
  tools: ToolMeta[],
  projectName: string,
  projectDescription: string,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const tool of tools) {
    const pathSegment = toKebabCase(tool.toolName);
    const path = `/${pathSegment}`;

    const requestProperties: Record<string, unknown> = {};
    for (const param of tool.parameters) {
      requestProperties[param] = { type: 'string' };
    }

    paths[path] = {
      post: {
        operationId: tool.toolName,
        summary: tool.description,
        tags: [tool.agentName],
        requestBody:
          tool.parameters.length > 0
            ? {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: requestProperties,
                    },
                  },
                },
              }
            : undefined,
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { type: 'object' },
                example: generateMockData(tool.toolName, tool.description),
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: `${projectName} Mock API`,
      version: '1.0.0',
      description: `Auto-generated mock API server for ${projectDescription || projectName}`,
    },
    paths,
  };
}

// ─── Deterministic Mock Data ────────────────────────────────────────────

function generateMockData(toolName: string, description: string): unknown {
  const name = toolName.toLowerCase();

  // Pattern-based mock data
  if (
    name.includes('lookup') ||
    name.includes('get') ||
    name.includes('search') ||
    name.includes('find')
  ) {
    if (name.includes('order'))
      return { orderId: 'ORD-12345', status: 'shipped', total: 49.99, items: 3 };
    if (name.includes('user') || name.includes('customer'))
      return { userId: 'USR-001', name: 'Jane Doe', email: 'jane@example.com' };
    if (name.includes('balance') || name.includes('account'))
      return { balance: 1250.0, currency: 'USD', lastUpdated: '2024-01-15T10:30:00Z' };
    if (name.includes('product') || name.includes('item'))
      return { productId: 'PRD-001', name: 'Widget Pro', price: 29.99, inStock: true };
    if (name.includes('ticket') || name.includes('case'))
      return { ticketId: 'TKT-001', status: 'open', priority: 'medium', subject: 'Sample ticket' };
    if (name.includes('appointment') || name.includes('schedule'))
      return { appointmentId: 'APT-001', date: '2024-02-01', time: '10:00', provider: 'Dr. Smith' };
    return { id: 'ITEM-001', status: 'found', data: { description } };
  }

  if (
    name.includes('create') ||
    name.includes('submit') ||
    name.includes('add') ||
    name.includes('register')
  ) {
    if (name.includes('ticket') || name.includes('case'))
      return { ticketId: 'TKT-002', status: 'created', createdAt: '2024-01-15T10:30:00Z' };
    if (name.includes('order'))
      return { orderId: 'ORD-NEW-001', status: 'pending', estimatedDelivery: '2024-01-20' };
    return { id: 'NEW-001', status: 'created', createdAt: '2024-01-15T10:30:00Z' };
  }

  if (name.includes('update') || name.includes('modify') || name.includes('edit')) {
    return { updated: true, modifiedAt: '2024-01-15T10:30:00Z' };
  }

  if (name.includes('delete') || name.includes('cancel') || name.includes('remove')) {
    return { deleted: true, deletedAt: '2024-01-15T10:30:00Z' };
  }

  if (name.includes('verify') || name.includes('check') || name.includes('validate')) {
    return { valid: true, verified: true, verifiedAt: '2024-01-15T10:30:00Z' };
  }

  if (name.includes('send') || name.includes('notify') || name.includes('email')) {
    return { sent: true, messageId: 'MSG-001', sentAt: '2024-01-15T10:30:00Z' };
  }

  // Default fallback
  return { success: true, data: {} };
}

// ─── Vercel Handler Template ────────────────────────────────────────────

function buildHandlerContent(operationId: string, method: string): string {
  return `import { readFile } from 'fs/promises';
import { join } from 'path';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const DATA_PATH = join(process.cwd(), '_data', '${operationId}.json');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method?.toUpperCase() !== '${method}') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const raw = await readFile(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return res.status(200).json(data);
  } catch {
    return res.status(200).json({ success: true, data: {} });
  }
}
`;
}

// ─── Main Generator ─────────────────────────────────────────────────────

const MAX_ENDPOINTS = 50;

/**
 * Generate a complete Vercel-deployable mock API project.
 *
 * This is a synchronous pipeline (per review item #2 and #5):
 * tools → OpenAPI spec → project files
 *
 * Returns the project name, OpenAPI spec, file list, and endpoint count.
 */
export function generateMockServerArtifacts(params: {
  tools: ToolMeta[];
  projectName: string;
  projectDescription: string;
}): MockServerArtifacts {
  const { tools, projectName, projectDescription } = params;

  if (tools.length === 0) {
    return { projectName: '', openApiSpec: {}, files: [], endpointCount: 0 };
  }

  // Generate OpenAPI spec
  const openApiSpec = generateOpenAPISpec(tools, projectName, projectDescription);

  // Generate project files
  const slug = toKebabCase(projectName);
  const shortHash = simpleHash(`${slug}-${Date.now()}`).toString(36).slice(0, 6);
  const mockProjectName = `${slug}-mocks-${shortHash}`;

  const files: MockProjectFile[] = [];

  // package.json
  files.push({
    path: 'package.json',
    content: JSON.stringify(
      {
        name: mockProjectName,
        version: '1.0.0',
        private: true,
        dependencies: { '@vercel/node': '^3.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      },
      null,
      2,
    ),
  });

  // vercel.json
  files.push({
    path: 'vercel.json',
    content: JSON.stringify(
      {
        headers: [
          {
            source: '/api/(.*)',
            headers: [
              { key: 'Access-Control-Allow-Origin', value: '*' },
              { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
              { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  });

  // OpenAPI schema
  files.push({
    path: 'api/_schema.json',
    content: JSON.stringify(openApiSpec, null, 2),
  });

  // Per-endpoint handlers + mock data
  let endpointCount = 0;
  const paths = (openApiSpec.paths as Record<string, Record<string, unknown>>) ?? {};

  for (const [pathKey, methods] of Object.entries(paths)) {
    if (endpointCount >= MAX_ENDPOINTS) break;

    for (const [method, operation] of Object.entries(methods)) {
      if (endpointCount >= MAX_ENDPOINTS) break;

      const op = operation as Record<string, unknown>;
      const operationId =
        (op.operationId as string) ?? `${method}_${pathKey.replace(/\//g, '_').replace(/^_/, '')}`;

      // Extract mock data from the OpenAPI example
      const responses = (op.responses as Record<string, unknown>) ?? {};
      const ok = (responses['200'] as Record<string, unknown>) ?? {};
      const content = (ok.content as Record<string, unknown>) ?? {};
      const json = (content['application/json'] as Record<string, unknown>) ?? {};
      const mockData = json.example ?? { success: true, data: {} };

      // Mock data file
      files.push({
        path: `_data/${operationId}.json`,
        content: JSON.stringify(mockData, null, 2),
      });

      // API handler
      const apiPath = pathKey.startsWith('/') ? pathKey.slice(1) : pathKey;
      files.push({
        path: `api/${apiPath}.ts`,
        content: buildHandlerContent(operationId, method.toUpperCase()),
      });

      endpointCount++;
    }
  }

  // README
  files.push({
    path: 'README.md',
    content: `# ${projectName} Mock API Server

Auto-generated mock API server with ${endpointCount} endpoints.

## Deploy to Vercel

\`\`\`bash
npm i -g vercel
vercel deploy
\`\`\`

## Endpoints

${tools.map((t) => `- \`POST /api/${toKebabCase(t.toolName)}\` — ${t.description}`).join('\n')}

## OpenAPI Spec

Available at \`/api/_schema.json\` after deployment.
`,
  });

  return {
    projectName: mockProjectName,
    openApiSpec,
    files,
    endpointCount,
  };
}
