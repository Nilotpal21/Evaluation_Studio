import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RepoIntelligenceService } from '../intelligence/repo-intelligence-service.js';
import {
  HelixControlPlaneService,
  type HelixControlPlaneServiceOptions,
} from './control-plane-service.js';
import { SESSION_STATES } from './types.js';

function createLogger(module: string) {
  const prefix = `[${module}]`;
  return {
    info: (message: string, details?: Record<string, unknown>) =>
      console.error(prefix, message, details ? JSON.stringify(details) : ''),
    error: (message: string, details?: Record<string, unknown>) =>
      console.error(prefix, 'ERROR', message, details ? JSON.stringify(details) : ''),
  };
}

const log = createLogger('helix-mcp');

export type HelixControlPlaneMcpServerOptions = HelixControlPlaneServiceOptions;

export class HelixControlPlaneMcpServer {
  private readonly server: McpServer;
  private readonly service: HelixControlPlaneService;
  private readonly repoIntelligence: RepoIntelligenceService;

  constructor(options: HelixControlPlaneMcpServerOptions = {}) {
    this.service = new HelixControlPlaneService(options);
    this.repoIntelligence = new RepoIntelligenceService({ workDir: options.workDir });
    this.server = new McpServer(
      {
        name: 'helix-control-plane',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log.info('HELIX control-plane MCP server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    log.info('HELIX control-plane MCP server stopped');
  }

  private registerTools(): void {
    this.server.tool(
      'list_sessions',
      'List HELIX sessions with current state, stage, and finding counts.',
      {
        limit: z.number().int().min(1).max(100).optional(),
        state: z.enum(SESSION_STATES).optional(),
        titleQuery: z.string().optional(),
      },
      async (args) => {
        return this.toTextResult(await this.service.listSessions(args));
      },
    );

    this.server.tool(
      'get_session',
      'Get a structured HELIX session summary by session id.',
      {
        sessionId: z.string().min(1),
      },
      async ({ sessionId }: { sessionId: string }) => {
        return this.toTextResult(await this.service.getSession(sessionId));
      },
    );

    this.server.tool(
      'get_slice_packet',
      'Get the complete packet for a HELIX slice, including manifest, tests, findings, and verification checkpoints.',
      {
        sessionId: z.string().min(1),
        sliceNumber: z.number().int().min(1),
      },
      async ({ sessionId, sliceNumber }: { sessionId: string; sliceNumber: number }) => {
        return this.toTextResult(await this.service.getSlicePacket(sessionId, sliceNumber));
      },
    );

    this.server.tool(
      'list_gate_results',
      'List slice exit-criterion results and cached verification checkpoints for a HELIX session.',
      {
        sessionId: z.string().min(1),
        sliceNumber: z.number().int().min(1).optional(),
      },
      async ({ sessionId, sliceNumber }: { sessionId: string; sliceNumber?: number }) => {
        return this.toTextResult(await this.service.listGateResults(sessionId, sliceNumber));
      },
    );

    this.server.tool(
      'get_dependency_dag',
      'Return the HELIX slice dependency graph for a session.',
      {
        sessionId: z.string().min(1),
      },
      async ({ sessionId }: { sessionId: string }) => {
        return this.toTextResult(await this.service.getDependencyDag(sessionId));
      },
    );

    this.server.tool(
      'search_findings',
      'Search findings across one or all HELIX sessions.',
      {
        query: z.string().min(1),
        sessionId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({
        query,
        sessionId,
        limit,
      }: {
        query: string;
        sessionId?: string;
        limit?: number;
      }) => {
        return this.toTextResult(await this.service.searchFindings(query, sessionId, limit));
      },
    );

    this.server.tool(
      'explain_blocker',
      'Explain the current blocker for a HELIX session or a specific slice.',
      {
        sessionId: z.string().min(1),
        sliceNumber: z.number().int().min(1).optional(),
      },
      async ({ sessionId, sliceNumber }: { sessionId: string; sliceNumber?: number }) => {
        return this.toTextResult(await this.service.explainBlocker(sessionId, sliceNumber));
      },
    );

    this.server.tool(
      'helix_find_symbol',
      'Find exported TypeScript symbols in a scoped part of the repo. Prefer this over broad grep when you know the symbol name.',
      {
        symbol: z.string().min(1),
        scope: z.array(z.string().min(1)).max(20).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ symbol, scope, limit }) => {
        return this.toTextResult(await this.repoIntelligence.findSymbol(symbol, { scope, limit }));
      },
    );

    this.server.tool(
      'helix_find_references',
      "Find references to a TypeScript symbol within a scoped package or directory. When scope is omitted, HELIX searches the symbol's package by default.",
      {
        filePath: z.string().min(1),
        symbol: z.string().min(1),
        scope: z.array(z.string().min(1)).max(20).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeDefinition: z.boolean().optional(),
      },
      async ({ filePath, symbol, scope, limit, includeDefinition }) => {
        return this.toTextResult(
          await this.repoIntelligence.findReferences(filePath, symbol, {
            scope,
            limit,
            includeDefinition,
          }),
        );
      },
    );

    this.server.tool(
      'helix_get_route_info',
      'Inspect Express route registrations and inherited middleware in a route file or scoped package. Prefer this over broad grep when tracing auth or route wiring.',
      {
        filePath: z.string().min(1).optional(),
        scope: z.array(z.string().min(1)).max(20).optional(),
        method: z.string().min(1).optional(),
        pathContains: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ filePath, scope, method, pathContains, limit }) => {
        return this.toTextResult(
          await this.repoIntelligence.getRouteInfo({
            filePath,
            scope,
            method,
            pathContains,
            limit,
          }),
        );
      },
    );

    this.server.tool(
      'helix_get_schema_info',
      'Inspect exported Zod schemas and Mongoose Schema definitions in a file or scoped package. Prefer this over reopening files just to inspect validation or model shapes.',
      {
        filePath: z.string().min(1).optional(),
        symbol: z.string().min(1).optional(),
        scope: z.array(z.string().min(1)).max(20).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ filePath, symbol, scope, limit }) => {
        return this.toTextResult(
          await this.repoIntelligence.getSchemaInfo({
            filePath,
            symbol,
            scope,
            limit,
          }),
        );
      },
    );

    this.server.tool(
      'helix_get_impacted_tests',
      'Infer likely impacted tests for changed source files inside a scoped package or directory. Prefer this when deciding required tests or narrowing regression scope.',
      {
        paths: z.array(z.string().min(1)).min(1).max(20),
        scope: z.array(z.string().min(1)).max(20).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ paths, scope, limit }) => {
        return this.toTextResult(
          await this.repoIntelligence.getImpactedTests({
            paths,
            scope,
            limit,
          }),
        );
      },
    );
  }

  private toTextResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(value, null, 2),
        },
      ],
    };
  }
}
