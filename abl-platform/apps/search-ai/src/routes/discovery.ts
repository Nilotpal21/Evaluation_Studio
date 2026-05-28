/**
 * Discovery Routes
 *
 * Handles site discovery lifecycle: start discovery, stream SSE progress,
 * explore branches, stop, retrieve tree, select URLs, and domain lookup.
 * Proxies SSE events from crawler-mcp-server with two-tier persistence.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { verifyPlatformAccessToken } from '@agent-platform/shared-auth';
import { getModel } from '../db/index.js';
import { getConfig } from '../config/index.js';
import { isURLAllowed } from '../utils/ssrf-protection.js';
import type { ISiteDiscovery } from '@agent-platform/database/models';
import type { ITenantDiscovery } from '@agent-platform/database/models';

const log = createLogger('discovery');
const router: RouterType = Router();

const crawlerMcpUrl = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';

// ---------------------------------------------------------------------------
// In-memory tracking for active SSE streams — cleaned up on completion/error.
// Bounded: one entry per active discovery; entries removed on stream end.
// ---------------------------------------------------------------------------
const MAX_ACTIVE_DISCOVERIES = 500;
const activeDiscoveries: Map<string, boolean> = new Map();

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const DiscoveryIdParamSchema = z.object({ id: z.string().min(1) });

const StartDiscoverySchema = z.object({
  primaryUrl: z.string().url(),
  sampleUrls: z.array(z.string().url()).max(10).default([]),
  seeds: z
    .array(
      z.object({
        type: z.enum(['nav-section', 'target-url']),
        url: z.string().url(),
        label: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(20),
  maxDepth: z.number().int().min(1).max(20).optional(),
  sourceId: z.string().min(1).optional(),
});

const SelectUrlsSchema = z.object({
  selectedUrls: z.array(z.string().url()).max(50_000),
  selectionPatterns: z.array(z.string().max(500)).max(100).optional(),
});

const DiscoverMoreSchema = z.object({
  type: z.enum(['explore-branch', 'explore-all']),
  url: z.string().url(),
});

const DomainParamSchema = z.object({
  domain: z.string().min(1).max(253),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModels() {
  return {
    SiteDiscovery: getModel<ISiteDiscovery>('SiteDiscovery'),
    TenantDiscovery: getModel<ITenantDiscovery>('TenantDiscovery'),
  };
}

function extractDomain(urlStr: string): string {
  const parsed = new URL(urlStr);
  return parsed.hostname.replace(/^www\./, '');
}

interface ParsedSSEEvent {
  event?: string;
  data?: string;
}

/**
 * Parse an SSE buffer into discrete events.
 * Returns parsed events and leftover buffer text.
 */
function parseSSEBuffer(buffer: string): { parsed: ParsedSSEEvent[]; remaining: string } {
  const parsed: ParsedSSEEvent[] = [];
  const blocks = buffer.split('\n\n');
  // The last element may be incomplete — keep as remaining
  const remaining = blocks.pop() ?? '';

  for (const block of blocks) {
    if (!block.trim()) continue;
    const evt: ParsedSSEEvent = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        evt.event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        evt.data = line.slice('data:'.length).trim();
      }
    }
    if (evt.event || evt.data) {
      parsed.push(evt);
    }
  }
  return { parsed, remaining };
}

/**
 * Persist final discovery result into SiteDiscovery.
 */
async function persistFinalResult(
  domain: string,
  resultData: Record<string, unknown>,
): Promise<void> {
  const { SiteDiscovery } = getModels();
  try {
    // Convert discoveredUrls from [url, metadata] entries to flat objects if needed
    let discoveredUrls = resultData.discoveredUrls;
    if (Array.isArray(discoveredUrls)) {
      discoveredUrls = discoveredUrls.map((entry: unknown) => {
        if (Array.isArray(entry) && entry.length >= 2) {
          const [url, meta] = entry;
          return { url, ...(typeof meta === 'object' && meta !== null ? meta : {}), visited: true };
        }
        return entry;
      });
    }

    await SiteDiscovery.findOneAndUpdate(
      { domain },
      {
        $set: {
          navStructure: resultData.navStructure ?? [],
          discoveredUrls: discoveredUrls ?? [],
          treeHierarchy: resultData.treeHierarchy ?? [],
          siteProfile: resultData.siteProfile ?? {},
          sitemapUrls: resultData.sitemapUrls ?? [],
          breadcrumbChains: resultData.breadcrumbChains ?? [],
          lastDiscoveryAt: new Date(),
          totalPagesVisited:
            typeof resultData.totalPagesVisited === 'number' ? resultData.totalPagesVisited : 0,
          totalUrlsFound:
            typeof resultData.totalUrlsFound === 'number' ? resultData.totalUrlsFound : 0,
        },
      },
      { upsert: true, new: true },
    );
    log.info('Persisted final discovery result', { domain });
  } catch (err) {
    log.error('Failed to persist final discovery result', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Truncate foundOn arrays to 10 entries per page for BSON safety.
 * Returns null if serialized size > 12MB (to preserve previously persisted data).
 */
function truncateFoundOnForPersistence(
  pages: Array<[string, unknown]>,
): Array<Record<string, unknown>> | null {
  const MAX_FOUND_ON = 10;
  const MAX_BSON_BYTES = 12 * 1024 * 1024;

  const truncated = pages.map(([url, page]: [string, any]) => ({
    ...page,
    url,
    foundOn: Array.isArray(page.foundOn) ? page.foundOn.slice(0, MAX_FOUND_ON) : [],
    childUrls: Array.isArray(page.childUrls) ? page.childUrls.slice(0, MAX_FOUND_ON) : [],
  }));

  // Quick size estimate: JSON length is a reasonable proxy for BSON size
  const estimatedSize = JSON.stringify(truncated).length;
  if (estimatedSize > MAX_BSON_BYTES) {
    log.warn('Skipping graph persist — estimated size exceeds 12MB', {
      estimatedSize,
      pageCount: truncated.length,
    });
    return null; // null = skip persist, preserve previous data
  }

  return truncated;
}

/**
 * Persist a tree snapshot to SiteDiscovery.
 * Fire-and-forget — errors are logged but do not propagate.
 */
async function persistTreeSnapshot(
  domain: string,
  tree: unknown[],
  totalUrls: number,
  totalVisited: number,
  discoveredPages?: Array<[string, unknown]>, // V2: graph data
): Promise<void> {
  const { SiteDiscovery } = getModels();
  try {
    const $set: Record<string, unknown> = {
      treeHierarchy: tree,
      totalPagesVisited: totalVisited,
      totalUrlsFound: totalUrls,
      lastDiscoveryAt: new Date(),
    };

    // V2: persist graph data on every snapshot (H-4 fix)
    if (discoveredPages && discoveredPages.length > 0) {
      const truncated = truncateFoundOnForPersistence(discoveredPages);
      if (truncated !== null) {
        // null = too large, skip to preserve previous data
        $set.discoveredUrls = truncated;
      }
    }

    await SiteDiscovery.findOneAndUpdate({ domain }, { $set }, { upsert: true, new: true });
    log.info('Persisted tree snapshot', { domain, totalUrls, totalVisited });
  } catch (err) {
    log.error('Failed to persist tree snapshot', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Verify tenant owns the discovery record. Returns the doc or null.
 */
async function verifyTenantOwnership(
  discoveryId: string,
  tenantId: string,
): Promise<ITenantDiscovery | null> {
  const { TenantDiscovery } = getModels();
  const doc = await TenantDiscovery.findOne({ discoveryId, tenantId }).lean();
  return doc as ITenantDiscovery | null;
}

// ---------------------------------------------------------------------------
// 1. POST /discovery/start
// ---------------------------------------------------------------------------
router.post('/discovery/start', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    const bodyParse = StartDiscoverySchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: bodyParse.error.message },
      });
    }

    const { primaryUrl, sampleUrls, seeds, maxDepth, sourceId } = bodyParse.data;

    // SSRF validate all URLs
    const allUrls = [primaryUrl, ...sampleUrls, ...seeds.map((s) => s.url)];
    for (const url of allUrls) {
      const check = await isURLAllowed(url);
      if (!check.allowed) {
        return res.status(400).json({
          success: false,
          error: { code: 'SSRF_BLOCKED', message: `URL blocked by security policy: ${url}` },
        });
      }
    }

    const domain = extractDomain(primaryUrl);
    const discoveryId = crypto.randomUUID();

    const { SiteDiscovery, TenantDiscovery } = getModels();

    // Upsert SiteDiscovery (generic per-domain)
    await SiteDiscovery.findOneAndUpdate(
      { domain },
      { $setOnInsert: { domain } },
      { upsert: true, new: true },
    );

    // Create/upsert TenantDiscovery
    const tenantDiscovery = await TenantDiscovery.findOneAndUpdate(
      { tenantId, domain, sourceId: sourceId ?? null },
      {
        $set: {
          discoveryId,
          seedsUsed: seeds,
          status: 'active',
          ...(maxDepth !== undefined ? { 'crawlConfig.maxDepth': maxDepth } : {}),
        },
        $setOnInsert: {
          tenantId,
          domain,
          sourceId: sourceId ?? undefined,
          exploredBranches: [],
          selectedUrls: [],
          selectionPatterns: [],
        },
      },
      { upsert: true, new: true },
    );

    const streamUrl = `/api/crawl/discovery/${discoveryId}/stream`;

    return res.json({
      success: true,
      data: {
        discoveryId,
        tenantDiscoveryId: tenantDiscovery._id,
        domain,
        streamUrl,
      },
    });
  } catch (err) {
    log.error('POST /discovery/start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /discovery/:id/stream (SSE proxy with two-tier persistence)
// ---------------------------------------------------------------------------
router.get('/discovery/:id/stream', async (req: Request, res: Response) => {
  const paramParse = DiscoveryIdParamSchema.safeParse(req.params);
  if (!paramParse.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
    });
  }

  const { id: discoveryId } = paramParse.data;

  // SSE auth: EventSource cannot send Authorization headers.
  // Accept ?token= query param (same pattern as progress.ts WebSocket auth).
  // Fall back to req.tenantContext if already set by upstream auth middleware.
  let tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (queryToken) {
      try {
        const config = getConfig();
        const decoded = verifyPlatformAccessToken(queryToken, config.jwt.secret);
        tenantId = decoded.tenantId;
      } catch {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
        });
      }
    }
  }
  if (!tenantId) {
    return res
      .status(401)
      .json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' } });
  }

  const tenantDiscovery = await verifyTenantOwnership(discoveryId, tenantId);
  if (!tenantDiscovery) {
    return res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Discovery not found' } });
  }

  // Idempotency guard
  if (activeDiscoveries.has(discoveryId)) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_RUNNING', message: 'Discovery stream is already active' },
    });
  }
  if (tenantDiscovery.status === 'completed') {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_COMPLETED', message: 'Discovery has already completed' },
    });
  }

  // Enforce bounded Map
  if (activeDiscoveries.size >= MAX_ACTIVE_DISCOVERIES) {
    return res.status(503).json({
      success: false,
      error: { code: 'CAPACITY_EXCEEDED', message: 'Too many active discoveries' },
    });
  }

  activeDiscoveries.set(discoveryId, true);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  const { TenantDiscovery } = getModels();
  const domain = tenantDiscovery.domain;

  // Persistence state
  let lastStatsPersist = Date.now();
  let totalPagesVisited = 0;
  let totalUrlsFound = 0;

  const cleanup = () => {
    activeDiscoveries.delete(discoveryId);
  };

  req.on('close', () => {
    cleanup();
    log.info('Client disconnected from SSE stream', { discoveryId });
  });

  try {
    // POST to crawler-mcp-server to start BFS discovery
    // Map seedsUsed to the upstream BfsDiscoverRequestSchema format.
    // Upstream expects: { discoveryId, primaryUrl, sampleUrls: string[], maxDepth? }
    const seeds = tenantDiscovery.seedsUsed ?? [];
    const primarySeed = seeds.find((s) => s.type === 'nav-section') ?? seeds[0];
    const targetUrls = seeds.filter((s) => s.type === 'target-url').map((s) => s.url);

    const bfsPayload = {
      discoveryId,
      primaryUrl: primarySeed?.url,
      sampleUrls: targetUrls,
      maxDepth: tenantDiscovery.crawlConfig?.maxDepth,
    };

    const upstreamRes = await fetch(`${crawlerMcpUrl}/api/bfs-discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bfsPayload),
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      cleanup();
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'Failed to start discovery upstream' })}\n\n`,
      );
      res.flush?.();
      return res.end();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { parsed, remaining } = parseSSEBuffer(buffer);
          buffer = remaining;

          for (const evt of parsed) {
            // Forward every event verbatim to the client
            if (evt.event) {
              res.write(`event: ${evt.event}\n`);
            }
            if (evt.data) {
              res.write(`data: ${evt.data}\n`);
            }
            res.write('\n');
            res.flush?.();

            // Event-specific persistence
            if (evt.event && evt.data) {
              try {
                const payload = JSON.parse(evt.data);

                switch (evt.event) {
                  case 'tree-snapshot': {
                    // Persist tree snapshot to SiteDiscovery (fire-and-forget)
                    const tree = Array.isArray(payload.tree) ? payload.tree : [];
                    const snapTotalUrls =
                      typeof payload.totalUrls === 'number' ? payload.totalUrls : 0;
                    const snapTotalVisited =
                      typeof payload.totalVisited === 'number' ? payload.totalVisited : 0;
                    totalPagesVisited = snapTotalVisited;
                    totalUrlsFound = snapTotalUrls;
                    persistTreeSnapshot(
                      domain,
                      tree,
                      snapTotalUrls,
                      snapTotalVisited,
                      payload.discoveredPages, // V2: graph data
                    ).catch((e: unknown) => {
                      log.error('tree-snapshot persist failed', {
                        discoveryId,
                        error: e instanceof Error ? e.message : String(e),
                      });
                    });
                    break;
                  }

                  case 'progress': {
                    // Update local counters and persist stats to TenantDiscovery
                    if (typeof payload.totalUrls === 'number') {
                      totalUrlsFound = payload.totalUrls;
                    }
                    if (typeof payload.totalVisited === 'number') {
                      totalPagesVisited = payload.totalVisited;
                    }
                    const now = Date.now();
                    if (now - lastStatsPersist >= 5_000) {
                      lastStatsPersist = now;
                      TenantDiscovery.updateOne(
                        { discoveryId, tenantId },
                        {
                          $set: {
                            'crawlConfig.lastStats': { totalPagesVisited, totalUrlsFound },
                          },
                        },
                      )
                        .exec()
                        .catch((e: unknown) => {
                          log.error('Progress stats persist failed', {
                            discoveryId,
                            error: e instanceof Error ? e.message : String(e),
                          });
                        });
                    }
                    break;
                  }

                  case 'complete': {
                    // Persist final tree from complete event and mark status
                    const finalTree = Array.isArray(payload.tree) ? payload.tree : [];
                    const completeTotalUrls =
                      typeof payload.totalUrls === 'number' ? payload.totalUrls : totalUrlsFound;
                    const completeTotalVisited =
                      typeof payload.totalVisited === 'number'
                        ? payload.totalVisited
                        : totalPagesVisited;
                    persistTreeSnapshot(
                      domain,
                      finalTree,
                      completeTotalUrls,
                      completeTotalVisited,
                      payload.discoveredPages, // V2: graph data
                    ).catch((e: unknown) => {
                      log.error('Complete tree persist failed', {
                        discoveryId,
                        error: e instanceof Error ? e.message : String(e),
                      });
                    });
                    TenantDiscovery.updateOne(
                      { discoveryId, tenantId },
                      {
                        $set: {
                          status: 'completed',
                          'crawlConfig.lastStats': {
                            totalPagesVisited: completeTotalVisited,
                            totalUrlsFound: completeTotalUrls,
                          },
                        },
                      },
                    )
                      .exec()
                      .catch((e: unknown) => {
                        log.error('Complete status update failed', {
                          discoveryId,
                          error: e instanceof Error ? e.message : String(e),
                        });
                      });
                    break;
                  }

                  case 'error': {
                    // Mark TenantDiscovery as error — last tree-snapshot is recovery point
                    TenantDiscovery.updateOne(
                      { discoveryId, tenantId },
                      { $set: { status: 'error' } },
                    )
                      .exec()
                      .catch((e: unknown) => {
                        log.error('Error status update failed', {
                          discoveryId,
                          error: e instanceof Error ? e.message : String(e),
                        });
                      });
                    break;
                  }

                  case 'result': {
                    // Persist full discovery result (navStructure, discoveredUrls, siteProfile, etc.)
                    const resultData = payload as Record<string, unknown>;
                    persistFinalResult(domain, resultData).catch((e: unknown) => {
                      log.error('Failed to persist result event', {
                        discoveryId,
                        error: e instanceof Error ? e.message : String(e),
                      });
                    });
                    break;
                  }

                  // phase, activity — forwarded only, no persistence needed
                  default:
                    break;
                }
              } catch {
                // Non-JSON data — skip event-specific persistence
              }
            }
          }
        }
      } catch (err) {
        log.error('SSE read loop error', {
          discoveryId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Stream interrupted' })}\n\n`);
        res.flush?.();
      } finally {
        cleanup();

        // Safety net: mark as completed only if still active
        // (complete/error events already set the appropriate status)
        try {
          await TenantDiscovery.updateOne(
            { discoveryId, tenantId, status: 'active' },
            { $set: { status: 'completed' } },
          ).exec();
        } catch (e) {
          log.error('Failed to mark discovery completed', {
            discoveryId,
            error: e instanceof Error ? e.message : String(e),
          });
        }

        res.end();
      }
    };

    // Fire the read loop — don't await it since SSE is long-lived
    readLoop().catch((e: unknown) => {
      log.error('SSE read loop unhandled error', {
        discoveryId,
        error: e instanceof Error ? e.message : String(e),
      });
      cleanup();
    });
  } catch (err) {
    cleanup();
    log.error('GET /discovery/:id/stream failed', {
      discoveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.write(
      `event: error\ndata: ${JSON.stringify({ message: 'Failed to establish upstream connection' })}\n\n`,
    );
    res.flush?.();
    return res.end();
  }
});

// ---------------------------------------------------------------------------
// 3. POST /discovery/:id/discover-more
// ---------------------------------------------------------------------------
router.post('/discovery/:id/discover-more', async (req: Request, res: Response) => {
  try {
    const paramParse = DiscoveryIdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
      });
    }

    const bodyParse = DiscoverMoreSchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: bodyParse.error.message },
      });
    }

    const { id: discoveryId } = paramParse.data;
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    // SSRF check
    const check = await isURLAllowed(bodyParse.data.url);
    if (!check.allowed) {
      return res.status(400).json({
        success: false,
        error: { code: 'SSRF_BLOCKED', message: 'URL blocked by security policy' },
      });
    }

    const tenantDiscovery = await verifyTenantOwnership(discoveryId, tenantId);
    if (!tenantDiscovery) {
      return res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Discovery not found' } });
    }

    // Forward command to crawler-mcp-server — transform to upstream command schema.
    // Upstream expects: { type, payload: { url?, urls? } }
    const commandPayload =
      bodyParse.data.type === 'explore-all'
        ? { type: bodyParse.data.type, payload: { urls: [bodyParse.data.url] } }
        : { type: bodyParse.data.type, payload: { url: bodyParse.data.url } };

    const upstreamRes = await fetch(`${crawlerMcpUrl}/api/bfs-discover/${discoveryId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandPayload),
    });

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text().catch(() => 'Unknown upstream error');
      log.error('Upstream discover-more failed', {
        discoveryId,
        status: upstreamRes.status,
        errorText,
      });
      return res.status(502).json({
        success: false,
        error: { code: 'UPSTREAM_ERROR', message: 'Failed to forward discover-more command' },
      });
    }

    // Track explored branch
    const { TenantDiscovery } = getModels();
    await TenantDiscovery.updateOne(
      { discoveryId, tenantId },
      { $addToSet: { exploredBranches: bodyParse.data.url } },
    ).exec();

    return res.json({ success: true, data: { discoveryId, url: bodyParse.data.url } });
  } catch (err) {
    log.error('POST /discovery/:id/discover-more failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

// ---------------------------------------------------------------------------
// 4. POST /discovery/:id/stop
// ---------------------------------------------------------------------------
router.post('/discovery/:id/stop', async (req: Request, res: Response) => {
  try {
    const paramParse = DiscoveryIdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
      });
    }

    const { id: discoveryId } = paramParse.data;
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    const tenantDiscovery = await verifyTenantOwnership(discoveryId, tenantId);
    if (!tenantDiscovery) {
      return res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Discovery not found' } });
    }

    // Forward stop command to crawler-mcp-server
    const upstreamRes = await fetch(`${crawlerMcpUrl}/api/bfs-discover/${discoveryId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stop' }),
    });

    if (!upstreamRes.ok) {
      log.warn('Upstream stop command failed', { discoveryId, status: upstreamRes.status });
    }

    // Mark as completed regardless
    const { TenantDiscovery } = getModels();
    await TenantDiscovery.updateOne(
      { discoveryId, tenantId },
      { $set: { status: 'completed' } },
    ).exec();

    activeDiscoveries.delete(discoveryId);

    return res.json({ success: true, data: { discoveryId, stopped: true } });
  } catch (err) {
    log.error('POST /discovery/:id/stop failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /discovery/:id/tree
// ---------------------------------------------------------------------------
router.get('/discovery/:id/tree', async (req: Request, res: Response) => {
  try {
    const paramParse = DiscoveryIdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
      });
    }

    const { id: discoveryId } = paramParse.data;
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    const tenantDiscovery = await verifyTenantOwnership(discoveryId, tenantId);
    if (!tenantDiscovery) {
      return res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Discovery not found' } });
    }

    const { SiteDiscovery } = getModels();
    const siteDiscovery = await SiteDiscovery.findOne({ domain: tenantDiscovery.domain }).lean();

    return res.json({
      success: true,
      data: {
        site: siteDiscovery ?? null,
        tenant: tenantDiscovery,
      },
    });
  } catch (err) {
    log.error('GET /discovery/:id/tree failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

// ---------------------------------------------------------------------------
// 6. POST /discovery/:id/select
// ---------------------------------------------------------------------------
router.post('/discovery/:id/select', async (req: Request, res: Response) => {
  try {
    const paramParse = DiscoveryIdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
      });
    }

    const bodyParse = SelectUrlsSchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: bodyParse.error.message },
      });
    }

    const { id: discoveryId } = paramParse.data;
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    const tenantDiscovery = await verifyTenantOwnership(discoveryId, tenantId);
    if (!tenantDiscovery) {
      return res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Discovery not found' } });
    }

    const { TenantDiscovery } = getModels();
    await TenantDiscovery.updateOne(
      { discoveryId, tenantId },
      {
        $set: {
          selectedUrls: bodyParse.data.selectedUrls,
          selectionPatterns: bodyParse.data.selectionPatterns ?? [],
        },
      },
    ).exec();

    return res.json({
      success: true,
      data: {
        discoveryId,
        selectedCount: bodyParse.data.selectedUrls.length,
      },
    });
  } catch (err) {
    log.error('POST /discovery/:id/select failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /discovery/domain/:domain
//    Static path prefix — no collision with :id routes.
// ---------------------------------------------------------------------------
router.get('/discovery/domain/:domain', async (req: Request, res: Response) => {
  try {
    const paramParse = DomainParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: paramParse.error.message },
      });
    }

    const { domain } = paramParse.data;

    const { SiteDiscovery } = getModels();
    const siteDiscovery = await SiteDiscovery.findOne({ domain }).lean();

    if (!siteDiscovery) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Site discovery data not found for domain' },
      });
    }

    return res.json({ success: true, data: siteDiscovery });
  } catch (err) {
    log.error('GET /discovery/domain/:domain failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

export default router;
