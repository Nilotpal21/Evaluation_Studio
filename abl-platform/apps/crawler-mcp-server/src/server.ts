import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { BrowserPool } from './browser/pool.js';
import * as tools from './tools/index.js';
import {
  exploreNavigation,
  type NavigationExploreConfig,
  type ExploreProgress,
} from './explore/navigation-explorer.js';
import { attachApiInterceptor } from './explore/api-interceptor.js';
import { probeDepth, type DepthProbeConfig } from './explore/depth-prober.js';
import { enqueueCommand, type Intervention } from './explore/command-queue.js';
import {
  runBfsDiscovery,
  type BfsDiscoveryConfig,
  type BfsProgressEvent,
} from './explore/bfs-discovery.js';
import {
  NavigateArgsSchema,
  GetPageContentArgsSchema,
  ClickElementArgsSchema,
  TypeTextArgsSchema,
  ScrollArgsSchema,
  WaitForElementArgsSchema,
  ExtractLinksArgsSchema,
  ExtractElementsArgsSchema,
  TakeScreenshotArgsSchema,
  ExecuteJavaScriptArgsSchema,
  GetPageStateArgsSchema,
} from './types/index.js';
import { createLogger } from './logger.js';

const log = createLogger('crawler-mcp-server');

/**
 * MCP Crawler Server
 *
 * Exposes browser automation primitives as MCP tools.
 * Used by ABL agents to navigate and interact with web pages.
 */
export class CrawlerMCPServer {
  private mcpServer: McpServer;
  private browserPool: BrowserPool;
  private transport: StdioServerTransport | null = null;
  private httpApp: Express | null = null;
  private httpServer: Server | null = null;
  private httpTransport: StreamableHTTPServerTransport | null = null;
  private isShuttingDown = false;

  constructor() {
    this.mcpServer = new McpServer(
      {
        name: 'crawler',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.browserPool = new BrowserPool({
      headless: process.env.HEADLESS !== 'false',
      maxPagesPerBrowser: 50,
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
    });

    this.registerTools(this.mcpServer);
    this.setupShutdown();
  }

  /**
   * Create a new McpServer instance with all tools registered.
   * Used in HTTP mode to avoid the "Already connected to a transport" error
   * that occurs when calling connect() multiple times on the same McpServer.
   */
  private createMcpServerInstance(): McpServer {
    const server = new McpServer(
      {
        name: 'crawler',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    this.registerTools(server);
    return server;
  }

  private registerTools(server: McpServer) {
    const sessionId = 'default'; // For now use default session

    // Navigate tool
    server.tool(
      'navigate',
      'Navigate to a URL and wait for page load',
      {
        url: z.string().url(),
        waitFor: z.enum(['load', 'networkidle', 'domcontentloaded']).optional(),
        timeout: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = NavigateArgsSchema.parse(args);
        const result = await tools.navigate(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Get page content tool
    server.tool(
      'get_page_content',
      'Get current page HTML, text, and optional screenshot',
      {
        includeHtml: z.boolean().optional(),
        includeText: z.boolean().optional(),
        includeScreenshot: z.boolean().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = GetPageContentArgsSchema.parse(args);
        const result = await tools.getPageContent(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Click element tool
    server.tool(
      'click_element',
      'Click an element on the page',
      {
        selector: z.string(),
        waitAfterClick: z.number().optional(),
        timeout: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = ClickElementArgsSchema.parse(args);
        const result = await tools.clickElement(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Type text tool
    server.tool(
      'type_text',
      'Type text into an input field',
      {
        selector: z.string(),
        text: z.string(),
        pressEnter: z.boolean().optional(),
        clearFirst: z.boolean().optional(),
        timeout: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = TypeTextArgsSchema.parse(args);
        const result = await tools.typeText(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Scroll tool
    server.tool(
      'scroll',
      'Scroll the page',
      {
        direction: z.enum(['down', 'up', 'to_bottom', 'to_top']),
        amount: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = ScrollArgsSchema.parse(args);
        const result = await tools.scroll(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Wait for element tool
    server.tool(
      'wait_for_element',
      'Wait for an element to appear on the page',
      {
        selector: z.string(),
        timeout: z.number().optional(),
        state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = WaitForElementArgsSchema.parse(args);
        const result = await tools.waitForElement(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Extract links tool
    server.tool(
      'extract_links',
      'Extract all links from the current page',
      {
        filter: z.string().optional(),
        includeExternal: z.boolean().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = ExtractLinksArgsSchema.parse(args);
        const result = await tools.extractLinks(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Extract elements tool
    server.tool(
      'extract_elements',
      'Extract elements matching a selector',
      {
        selector: z.string(),
        attributes: z.array(z.string()).optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = ExtractElementsArgsSchema.parse(args);
        const result = await tools.extractElements(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Take screenshot tool
    server.tool(
      'take_screenshot',
      'Take a screenshot of the page or element',
      {
        selector: z.string().optional(),
        fullPage: z.boolean().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = TakeScreenshotArgsSchema.parse(args);
        const result = await tools.takeScreenshot(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Execute JavaScript tool
    server.tool(
      'execute_javascript',
      'Execute JavaScript code in the page context',
      {
        code: z.string(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = ExecuteJavaScriptArgsSchema.parse(args);
        const result = await tools.executeJavaScript(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    // Get page state tool
    server.tool(
      'get_page_state',
      'Get current page state (URL, title, scroll position, etc.)',
      {
        includeCookies: z.boolean().optional(),
        includeLocalStorage: z.boolean().optional(),
      },
      async (args) => {
        const page = await this.browserPool.getPage(sessionId);
        const validatedArgs = GetPageStateArgsSchema.parse(args);
        const result = await tools.getPageState(page, validatedArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );
  }

  private setupShutdown() {
    const gracefulShutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      try {
        log.info('Shutting down MCP server');
        await this.close();
        process.exit(0);
      } catch (err) {
        log.error('MCP server shutdown error, forcing exit', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      }
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  }

  /**
   * Start the MCP server in stdio transport mode.
   * This is the original transport — reads JSON-RPC from stdin, writes to stdout.
   */
  async startStdio() {
    await this.browserPool.initialize();

    this.transport = new StdioServerTransport();
    await this.mcpServer.connect(this.transport);

    log.info('MCP Crawler Server started successfully (stdio)');
  }

  /**
   * Start the MCP server in HTTP transport mode.
   * Uses StreamableHTTPServerTransport from the MCP SDK with Express for body parsing.
   *
   * Routes:
   *   GET  /health → { status: 'ok' }
   *   POST /mcp    → MCP Streamable HTTP endpoint
   *   GET  /mcp    → MCP Streamable HTTP endpoint (SSE stream)
   *   DELETE /mcp  → MCP session termination
   *
   * @param port - TCP port to listen on (default 3100)
   * @returns Promise that resolves when the server is listening
   */
  async startHttp(port: number = 3100): Promise<void> {
    await this.browserPool.initialize();

    // createMcpExpressApp provides body parsing and DNS rebinding protection
    const app = createMcpExpressApp({ host: '0.0.0.0' });
    // Raise body limit for resume context (visitedUrls can be up to 15K entries ~1.5MB)
    app.use(express.json({ limit: '5mb' }));
    this.httpApp = app;

    // Health check endpoint — registered before MCP routes
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // ─── REST API: Navigation Exploration ────────────────────────────
    // POST /api/explore — Start browser-based navigation exploration
    // Returns SSE stream of progress events, then final result.
    const ExploreRequestSchema = z.object({
      url: z.string().url(),
      maxDepth: z.number().int().min(1).max(10).optional(),
      maxExpansions: z.number().int().min(1).max(1000).optional(),
      expandableSelectors: z.array(z.string()).max(20).optional(),
      linkFilter: z.string().max(500).optional(),
      sampleUrls: z.array(z.string().url()).max(50).optional(),
      timeout: z.number().int().min(1000).max(60000).optional(),
    });

    app.post('/api/explore', async (req, res) => {
      const parsed = ExploreRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }

      const { url, maxDepth, maxExpansions, expandableSelectors, linkFilter, sampleUrls, timeout } =
        parsed.data;

      const config: NavigationExploreConfig = {
        url,
        maxDepth: maxDepth ?? 4,
        maxExpansions: maxExpansions ?? 300,
        expandableSelectors,
        linkFilter,
        sampleUrls,
        timeout: timeout ?? 5000,
      };

      // Use a dedicated session for this exploration (not the default MCP session)
      const sessionId = `explore-${Date.now()}`;

      // Set up SSE — disable Nagle and force chunked streaming mode.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      res.flushHeaders();
      // Disable Nagle's algorithm so each write() sends immediately
      req.socket.setNoDelay(true);

      let stopped = false;
      res.on('close', () => {
        stopped = true;
      });

      const sendSSE = (event: string, data: unknown) => {
        if (stopped) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          stopped = true;
        }
      };

      try {
        log.info('Starting navigation exploration', { url, sessionId, maxDepth: config.maxDepth });
        const page = await this.browserPool.getPage(sessionId);

        // Attach API interceptor before navigation to capture all XHR/fetch calls
        const parsedUrl = new URL(url);
        const interceptor = await attachApiInterceptor(page, parsedUrl.hostname);

        // Throttle progress events (max once per 200ms)
        let lastProgressTime = 0;
        const PROGRESS_THROTTLE_MS = 200;

        const result = await exploreNavigation(
          page,
          config,
          (progress: ExploreProgress) => {
            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
              lastProgressTime = now;
              sendSSE('progress', progress);
            }
          },
          () => stopped,
        );

        // Collect API interception results and detach
        const apiResult = interceptor.getResult();
        await interceptor.detach();

        // Merge API interception data into the result
        const enrichedResult = {
          ...result,
          apiInterception:
            apiResult.patterns.length > 0 || apiResult.structuredCount > 0
              ? {
                  patterns: apiResult.patterns,
                  totalIntercepted: apiResult.totalIntercepted,
                  structuredCount: apiResult.structuredCount,
                }
              : undefined,
        };

        sendSSE('complete', enrichedResult);

        if (apiResult.patterns.length > 0) {
          log.info('API patterns detected during exploration', {
            sessionId,
            patternCount: apiResult.patterns.length,
            paginatedCount: apiResult.patterns.filter((p) => p.isPaginated).length,
            structuredCalls: apiResult.structuredCount,
          });
        }

        log.info('Navigation exploration completed', {
          sessionId,
          links: result.stats.totalLinks,
          clicks: result.stats.totalClicks,
          durationMs: result.stats.durationMs,
          apiCalls: apiResult.totalIntercepted,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Navigation exploration failed', { sessionId, error: message });
        sendSSE('error', { message });
      } finally {
        // Cleanup the session — log but don't propagate cleanup errors
        await this.browserPool.closeSession(sessionId).catch((cleanupErr: unknown) => {
          log.warn('Session cleanup failed', {
            sessionId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        });
        if (!stopped) {
          res.end();
        }
      }
    });

    // ─── REST API: Deep Navigation Exploration (Depth Probing) ───────
    // POST /api/explore-deep — Sample-guided multi-page exploration
    // Explores seed page, then probes deeper by sampling category links.
    // Returns SSE stream of progress events, then final result.
    const ExploreDeepRequestSchema = z.object({
      url: z.string().url(),
      // Depth probing settings (advanced — all optional)
      depthProbing: z
        .object({
          enabled: z.boolean().optional(),
          maxPageVisits: z.number().int().min(1).max(50).optional(),
          maxDepth: z.number().int().min(0).max(10).optional(),
          sampleSize: z.number().int().min(1).max(5).optional(),
        })
        .optional(),
      // Per-page exploration settings (passed to single-page explorer)
      maxDepth: z.number().int().min(1).max(10).optional(),
      maxExpansions: z.number().int().min(1).max(1000).optional(),
      expandableSelectors: z.array(z.string()).max(20).optional(),
      sampleUrls: z.array(z.string().url()).max(50).optional(),
      timeout: z.number().int().min(1000).max(60000).optional(),
      totalTimeout: z.number().int().min(10000).max(300000).optional(),
      /** Context from prior discovery iterations for resume */
      resumeContext: z
        .object({
          visitedUrls: z.array(z.string().min(1)).max(15000).optional(),
          exploredBranches: z.array(z.string().min(1).max(2048)).max(500).optional(),
          iterationCount: z.number().int().min(0).max(100).optional(),
        })
        .optional(),
      /** Exploration ID — used for command queue lookups to enable mid-stream interventions */
      exploreId: z.string().min(1).optional(),
    });

    app.post('/api/explore-deep', async (req, res) => {
      const parsed = ExploreDeepRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }

      const {
        url,
        depthProbing,
        maxDepth: exploreMaxDepth,
        maxExpansions,
        expandableSelectors,
        sampleUrls,
        timeout,
        totalTimeout,
        resumeContext,
        exploreId,
      } = parsed.data;

      const depthConfig: DepthProbeConfig = {
        url,
        enabled: depthProbing?.enabled ?? true,
        maxPageVisits: depthProbing?.maxPageVisits ?? 20,
        maxDepth: depthProbing?.maxDepth ?? 5,
        sampleSize: depthProbing?.sampleSize ?? 2,
        totalTimeout: totalTimeout ?? 300_000,
        exploreConfig: {
          maxDepth: exploreMaxDepth ?? 4,
          maxExpansions: maxExpansions ?? 300,
          expandableSelectors,
          sampleUrls,
          timeout: timeout ?? 5000,
        },
        previouslyVisitedUrls: resumeContext?.visitedUrls,
        exploreId,
      };

      const sessionId = `explore-deep-${Date.now()}`;

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      res.flushHeaders();
      req.socket.setNoDelay(true);

      let stopped = false;
      res.on('close', () => {
        stopped = true;
      });

      const sendSSE = (event: string, data: unknown) => {
        if (stopped) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          stopped = true;
        }
      };

      // Throttle progress events
      let lastProgressTime = 0;
      const PROGRESS_THROTTLE_MS = 200;

      try {
        log.info('Starting deep navigation exploration', {
          url,
          sessionId,
          depthProbing: depthConfig.enabled,
          maxPageVisits: depthConfig.maxPageVisits,
          maxDepth: depthConfig.maxDepth,
          sampleSize: depthConfig.sampleSize,
        });

        let navExtractedSent = false;
        const result = await probeDepth(
          this.browserPool,
          depthConfig,
          (progress) => {
            // Emit nav-extracted as a dedicated event (once)
            if (progress.navResult && !navExtractedSent) {
              navExtractedSent = true;
              sendSSE('nav-extracted', progress.navResult);
            }

            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
              lastProgressTime = now;
              sendSSE('progress', progress);
            }
          },
          () => stopped,
        );

        sendSSE('complete', result);

        log.info('Deep navigation exploration completed', {
          sessionId,
          totalLinks: result.stats.totalLinks,
          verifiedLinks: result.stats.verifiedLinks,
          projectedLinks: result.stats.projectedLinks,
          pagesVisited: result.stats.pagesVisited,
          maxDepthReached: result.stats.maxDepthReached,
          groupsProbed: result.stats.groupsProbed,
          durationMs: result.stats.durationMs,
          apiPatterns: result.apiInterception?.patterns.length ?? 0,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Deep navigation exploration failed', { sessionId, error: message });
        sendSSE('error', { message });
      } finally {
        if (!stopped) {
          res.end();
        }
      }
    });

    // ─── POST /api/explore/:id/command — Receive intervention commands ──
    const CommandSchema = z.object({
      type: z.enum([
        'stop',
        'add-sample',
        'explore-branch',
        'skip-branch',
        'explore-all',
        'undo-skip',
      ]),
      payload: z
        .object({
          url: z.string().url().optional(),
          urls: z.array(z.string().url()).max(100).optional(),
          maxDepth: z.number().int().min(1).max(10).optional(),
        })
        .optional(),
    });

    app.post('/api/explore/:id/command', (req, res) => {
      const idParsed = z.string().min(1).safeParse(req.params.id);
      if (!idParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid exploration ID' },
        });
        return;
      }

      const bodyParsed = CommandSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }

      const exploreId = idParsed.data;
      const command: Intervention = {
        ...bodyParsed.data,
        receivedAt: Date.now(),
      };

      const queued = enqueueCommand(exploreId, command);
      if (!queued) {
        res.status(429).json({
          success: false,
          error: { code: 'QUEUE_FULL', message: 'Command queue is full' },
        });
        return;
      }

      log.info('Command consumed by prober', { exploreId, type: command.type });
      res.json({ success: true, data: { queued: true } });
    });

    // ─── REST API: BFS Discovery ─────────────────────────────────────
    // POST /api/bfs-discover — Start BFS discovery with SSE streaming
    const BfsDiscoverRequestSchema = z.object({
      discoveryId: z.string().min(1),
      primaryUrl: z.string().url(),
      sampleUrls: z.array(z.string().url()).max(10).default([]),
      maxDepth: z.number().int().min(1).max(20).optional(),
      pageTimeout: z.number().int().min(5000).max(60000).optional(),
    });

    app.post('/api/bfs-discover', async (req, res) => {
      const parsed = BfsDiscoverRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
        return;
      }

      const { discoveryId, primaryUrl, sampleUrls, maxDepth, pageTimeout } = parsed.data;

      const config: BfsDiscoveryConfig = {
        discoveryId,
        primaryUrl,
        sampleUrls,
        maxDepth: maxDepth ?? 8,
        pageTimeout: pageTimeout ?? 15_000,
        maxAllLinks: 50_000,
      };

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      res.flushHeaders();
      req.socket.setNoDelay(true);

      let stopped = false;
      res.on('close', () => {
        stopped = true;
      });

      const sendSSE = (event: string, data: unknown) => {
        if (stopped) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          stopped = true;
        }
      };

      try {
        log.info('Starting BFS discovery', { discoveryId, primaryUrl, maxDepth: config.maxDepth });

        const result = await runBfsDiscovery(
          config,
          this.browserPool,
          (event: BfsProgressEvent) => {
            // Forward all events directly — engine handles its own throttling
            sendSSE(event.type, event);
          },
          () => stopped,
        );

        // Send final result with Map serialized as entries array
        const serializedResult = {
          discoveryId: result.discoveryId,
          domain: result.domain,
          discoveredUrls: [...result.discoveredUrls.entries()],
          treeHierarchy: result.treeHierarchy,
          navStructure: result.navStructure,
          breadcrumbChains: result.breadcrumbChains,
          stats: result.stats,
        };

        sendSSE('result', serializedResult);

        log.info('BFS discovery completed', {
          discoveryId,
          totalUrls: result.stats.totalUrls,
          totalVisited: result.stats.totalVisited,
          durationMs: result.stats.durationMs,
          stoppedBy: result.stats.stoppedBy,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('BFS discovery failed', { discoveryId, error: message });
        sendSSE('error', { type: 'error', message, timestamp: Date.now() });
      } finally {
        if (!stopped) {
          res.end();
        }
      }
    });

    // ─── POST /api/bfs-discover/:id/command — BFS intervention commands ──
    const BfsCommandRequestSchema = z.object({
      type: z.enum(['stop', 'explore-branch', 'explore-all', 'skip-branch', 'undo-skip']),
      payload: z
        .object({
          url: z.string().url().optional(),
          urls: z.array(z.string().url()).max(50).optional(),
          maxDepth: z.number().int().min(1).max(20).optional(),
        })
        .optional(),
    });

    app.post('/api/bfs-discover/:id/command', (req, res) => {
      const idParsed = z.string().min(1).safeParse(req.params.id);
      if (!idParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid discovery ID' },
        });
        return;
      }

      const bodyParsed = BfsCommandRequestSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
        });
        return;
      }

      const discoveryId = idParsed.data;
      const command: Intervention = {
        ...bodyParsed.data,
        receivedAt: Date.now(),
      };

      const queued = enqueueCommand(discoveryId, command);
      if (!queued) {
        res.status(429).json({
          success: false,
          error: { code: 'QUEUE_FULL', message: 'Command queue is full' },
        });
        return;
      }

      log.info('BFS command enqueued', { discoveryId, type: command.type });
      res.json({ success: true, data: { queued: true } });
    });

    // MCP Streamable HTTP endpoint — stateless mode (V1)
    app.all('/mcp', async (req, res) => {
      try {
        // Create a new stateless transport per request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless mode
        });

        // Create a fresh McpServer per request to avoid "Already connected" errors
        if (req.method === 'POST') {
          const server = this.createMcpServerInstance();
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          await server.close();
        } else {
          await transport.handleRequest(req, res, req.body);
        }
      } catch (err) {
        log.error('Error handling MCP HTTP request', {
          error: err instanceof Error ? err.message : String(err),
          method: req.method,
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    // Root path also serves MCP for convenience
    app.all('/', async (req, res) => {
      if (req.method === 'GET' && !req.headers.accept?.includes('text/event-stream')) {
        // Plain GET to root — redirect to health
        res.json({ status: 'ok', transport: 'http', mcp_endpoint: '/mcp' });
        return;
      }
      // Forward to /mcp handler logic
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        if (req.method === 'POST') {
          const server = this.createMcpServerInstance();
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          await server.close();
        } else {
          await transport.handleRequest(req, res, req.body);
        }
      } catch (err) {
        log.error('Error handling MCP HTTP request at /', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    // Start listening
    return new Promise<void>((resolve, reject) => {
      try {
        this.httpServer = app.listen(port, '0.0.0.0', () => {
          const addr = this.httpServer?.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          log.info('MCP Crawler Server started successfully (HTTP)', { port: actualPort });
          resolve();
        });
        this.httpServer.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get the actual port the HTTP server is listening on.
   * Useful when started with port 0 (random port).
   */
  getHttpPort(): number | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (typeof addr === 'object' && addr) {
      return addr.port;
    }
    return null;
  }

  async close() {
    // Close HTTP transport if exists
    try {
      if (this.httpTransport) {
        await this.httpTransport.close();
        this.httpTransport = null;
      }
    } catch (err) {
      log.error('HTTP transport close error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close HTTP server if exists
    try {
      if (this.httpServer) {
        await new Promise<void>((resolve, reject) => {
          this.httpServer!.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
        this.httpServer = null;
        this.httpApp = null;
      }
    } catch (err) {
      log.error('HTTP server close error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close MCP server (stdio transport)
    try {
      if (this.transport) {
        await this.mcpServer.close();
        this.transport = null;
      }
    } catch (err) {
      log.error('MCP server close error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close browser pool
    try {
      await this.browserPool.closeAll();
    } catch (err) {
      log.error('Browser pool close error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
