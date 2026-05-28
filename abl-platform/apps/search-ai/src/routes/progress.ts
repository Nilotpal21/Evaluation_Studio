/**
 * Real-Time Progress WebSocket API
 *
 * WebSocket endpoint for streaming live crawl job progress updates.
 * Uses Redis pub/sub to broadcast events across pods for high availability.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import type { RedisClient } from '@agent-platform/redis';
import { createSubscriber } from '@agent-platform/redis';
import cookie from 'cookie';
import { verifyPlatformAccessToken } from '@agent-platform/shared-auth';
import { getSharedRedisClient, getSharedRedisHandle } from '../workers/shared.js';
import { getConfig } from '../config/index.js';
import { getModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import type { IntelligenceAnalysisResult } from '@abl/crawler';

const logger = createLogger('progress-ws');

export interface ProgressEvent {
  type:
    | 'job_started'
    | 'url_fetched'
    | 'document_processed'
    | 'documents_processed' // Connector batch progress
    | 'chunk_created'
    | 'job_completed'
    | 'job_failed'
    | 'error'
    | 'intelligence_started'
    | 'intelligence_phase'
    | 'intelligence_complete'
    | 'intelligence_failed'
    // V4 multi-page intelligence crawl events
    | 'intelligence_crawl_discovering'
    | 'intelligence_crawl_started'
    | 'intelligence_page_started'
    | 'intelligence_page_phase'
    | 'intelligence_page_complete'
    | 'intelligence_page_failed'
    | 'intelligence_page_saved'
    | 'intelligence_crawl_complete'
    | 'intelligence_crawl_failed'
    // V6 algorithm events
    | 'intelligence_page_blocked'
    | 'intelligence_group_progress'
    // Bulk crawl events
    | 'url_skipped';
  jobId: string;
  timestamp: string;
  data?: {
    url?: string;
    documentId?: string;
    chunkId?: string;
    currentSite?: string; // Current site being processed (connectors)
    currentDocument?: string; // Current document name (connectors)
    rate?: number; // Documents per minute (connectors)
    eta?: string; // Estimated completion time (connectors)
    progress?: {
      total: number;
      completed: number;
      failed: number;
      percentage: number;
    };
    error?: {
      message: string;
      code?: string;
    };
    // Intelligence analysis fields
    phase?:
      | 'map'
      | 'understand'
      | 'build_handler'
      | 'replay'
      | 'reuse'
      | 'jsonld'
      | 'discovering'
      | 'processing';
    iteration?: number;
    maxIterations?: number;
    phaseDetail?: string;
    result?: IntelligenceAnalysisResult;
    // V4 multi-page intelligence crawl fields
    pageIndex?: number;
    totalPages?: number;
    handlerReused?: boolean;
    llmCalls?: number;
    reusablePages?: number;
    maxLlmCalls?: number;
    summary?: Record<string, unknown>;
    pagesCompleted?: number;
    // V6 algorithm fields
    method?: 'http' | 'playwright';
    qualityScore?: number;
    quality?: 'rich' | 'standard' | 'thin';
    interactiveFlags?: string[];
    jsonLdUsed?: boolean;
    a6RelevantLinks?: number;
    paginationDetected?: boolean;
    reason?: string;
    groupPattern?: string;
    completed?: number;
    total?: number;
    fastCount?: number;
    aiCount?: number;
    blockedCount?: number;
    // Bulk crawl fields
    status?: 'success' | 'failed';
    statusCode?: number;
    errorType?: string;
    duration?: number;
    sections?: Array<{ sectionId: string; name: string; count: number }>;
    score?: number;
    skipped?: number;
    comparison?: Record<string, number>;
    skipReason?: string;
  };
}

interface ProgressSubscription {
  jobId: string;
  ws: WebSocket;
  redis: RedisClient;
}

const MAX_SUBSCRIPTIONS = 500;
const activeSubscriptions = new Map<string, ProgressSubscription>();

/**
 * Initialize WebSocket server for progress updates
 */
export function initProgressWebSocket(httpServer: HTTPServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade requests with authentication
  httpServer.on('upgrade', async (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname.startsWith('/api/admin/progress/subscribe')) {
      // Parse cookies from request headers
      // Browser WebSocket automatically sends cookies with the upgrade request
      const cookies = cookie.parse(request.headers.cookie || '');
      // Also accept token as query param — Studio stores the JWT in-memory (Zustand),
      // not as a cookie, and the browser WebSocket API cannot send custom headers.
      const urlForToken = new URL(request.url || '', `http://${request.headers.host}`);
      const queryToken = urlForToken.searchParams.get('token');
      const token = queryToken || cookies.abl_token || cookies.accessToken;

      if (!token) {
        logger.warn('WebSocket upgrade rejected: No authentication token in cookies');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Verify JWT and extract tenantId
      try {
        const config = getConfig();
        const decoded = verifyPlatformAccessToken(token, config.jwt.secret);

        if (!decoded.tenantId) {
          logger.warn('WebSocket upgrade rejected: No tenantId in JWT');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // Extract jobId and job type from query
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        const jobId = url.searchParams.get('jobId');
        const jobType = url.searchParams.get('type') || 'crawler'; // Default to crawler for backward compatibility

        if (!jobId) {
          logger.warn('WebSocket upgrade rejected: Missing jobId parameter');
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        // Verify job belongs to tenant based on job type (critical security check)
        let job;
        if (jobType === 'connector-sync') {
          const ConnectorConfig = getModel('ConnectorConfig');
          // For connector jobs, jobId is the job ID from BullMQ, need to find connector via sync state
          // First try direct lookup by jobId in currentJobId field
          job = await ConnectorConfig.findOne({
            tenantId: decoded.tenantId,
            'syncState.currentJobId': jobId,
          }).lean();

          // Also support direct connector ID lookup for backward compatibility
          if (!job) {
            job = await ConnectorConfig.findOne({
              _id: jobId,
              tenantId: decoded.tenantId,
            }).lean();
          }
        } else if (jobType === 'intelligence') {
          // Intelligence analysis job — state stored in Redis, not MongoDB
          const lookupRedis = getSharedRedisClient();
          if (lookupRedis) {
            const redisKey = `intelligence:job:${jobId}`;
            const jobData = await lookupRedis.get(redisKey);
            if (jobData) {
              try {
                const parsed = JSON.parse(jobData);
                if (parsed.tenantId === decoded.tenantId) {
                  job = parsed;
                }
              } catch {
                logger.warn('Failed to parse intelligence job state', { jobId });
              }
            }
          }
        } else if (jobType === 'indexing') {
          // Indexing progress — subscribe to SearchIndex events during rebuilds.
          // jobId is the searchIndexId; verify tenant ownership.
          const SearchIndex = getModel('SearchIndex');
          job = await SearchIndex.findOne({
            _id: jobId,
            tenantId: decoded.tenantId,
          }).lean();
        } else {
          // Default: crawler job
          const CrawlJob = getModel('CrawlJob');
          job = await CrawlJob.findOne({ _id: jobId, tenantId: decoded.tenantId }).lean();
        }

        if (!job) {
          // Return 404 (not 403) to avoid leaking job existence
          logger.warn('WebSocket upgrade rejected: Job not found or cross-tenant access', {
            jobId,
            jobType,
            tenantId: decoded.tenantId,
          });
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        logger.info('WebSocket upgrade successful', {
          jobId,
          tenantId: decoded.tenantId,
          userId: decoded.sub,
        });

        // Attach tenant context to request for use in connection handler
        (request as any).tenantContext = { tenantId: decoded.tenantId, userId: decoded.sub };

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } catch (error) {
        logger.error('WebSocket upgrade failed: JWT verification error', {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  });

  // Handle WebSocket connections
  wss.on('connection', (ws, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: { code: 'MISSING_JOB_ID', message: 'Query parameter jobId is required' },
        }),
      );
      ws.close(1008, 'Missing jobId parameter');
      return;
    }

    logger.info('WebSocket client connected', { jobId });

    // Create Redis subscriber for this job (dedicated connection for SUBSCRIBE mode)
    const handle = getSharedRedisHandle();
    if (!handle) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: { code: 'REDIS_UNAVAILABLE', message: 'Redis not configured' },
        }),
      );
      ws.close(1011, 'Redis unavailable');
      return;
    }
    const subscriber = createSubscriber(handle);
    const channel = `progress:${jobId}`;

    // Subscribe to Redis channel
    subscriber.subscribe(channel, async (err: Error | null | undefined) => {
      if (err) {
        logger.error('Failed to subscribe to Redis channel', {
          channel,
          error: err?.message || String(err),
        });
        ws.send(
          JSON.stringify({
            type: 'error',
            error: { code: 'REDIS_SUBSCRIBE_ERROR', message: 'Failed to subscribe to job updates' },
          }),
        );
        ws.close(1011, 'Redis subscription failed');
        return;
      }

      logger.info('Subscribed to Redis channel', { channel, jobId });

      // Send connection success
      ws.send(
        JSON.stringify({
          type: 'connected',
          jobId,
          timestamp: new Date().toISOString(),
        }),
      );

      // Replay last cached event for late joiners
      try {
        const pub = getProgressPublisher();
        const cachedEvent = await pub.get(`progress:last:${jobId}`);
        if (cachedEvent && ws.readyState === WebSocket.OPEN) {
          ws.send(cachedEvent);
        }
      } catch (replayErr) {
        logger.warn('Failed to replay cached event', {
          jobId,
          error: replayErr instanceof Error ? replayErr.message : String(replayErr),
        });
      }
    });

    // Forward Redis messages to WebSocket client
    subscriber.on('message', (ch: string, message: string) => {
      if (ch === channel && ws.readyState === WebSocket.OPEN) {
        try {
          // Parse and validate the message
          const event: ProgressEvent = JSON.parse(message);
          ws.send(JSON.stringify(event));
        } catch (error) {
          logger.error('Failed to parse Redis message', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    // Guard against unbounded growth
    if (activeSubscriptions.size >= MAX_SUBSCRIPTIONS) {
      logger.warn('Max WebSocket subscriptions reached, rejecting new connection', {
        current: activeSubscriptions.size,
        max: MAX_SUBSCRIPTIONS,
      });
      subscriber.quit().catch((e) => {
        logger.debug('Redis quit error during subscription rejection', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
      ws.close(1013, 'Too many active subscriptions');
      return;
    }

    // Store subscription
    const subscriptionKey = `${jobId}-${Date.now()}`;
    activeSubscriptions.set(subscriptionKey, { jobId, ws, redis: subscriber });

    // Handle client disconnect
    ws.on('close', () => {
      logger.info('WebSocket client disconnected', { jobId });
      subscriber.unsubscribe(channel).catch(() => {
        // Ignore errors if connection already closed
      });
      subscriber.quit().catch(() => {
        // Ignore errors if connection already closed
      });
      activeSubscriptions.delete(subscriptionKey);
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error('WebSocket error', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      subscriber.unsubscribe(channel).catch(() => {
        // Ignore errors if connection already closed
      });
      subscriber.quit().catch(() => {
        // Ignore errors if connection already closed
      });
      activeSubscriptions.delete(subscriptionKey);
    });

    // Handle ping/pong for keepalive
    ws.on('pong', () => {
      // Keep connection alive
    });

    // Send periodic pings
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Ping every 30 seconds
  });

  return wss;
}

// Singleton Redis publisher for progress events (uses shared cluster-safe client)
let progressPublisher: RedisClient | null = null;

function getProgressPublisher(): RedisClient {
  if (!progressPublisher) {
    progressPublisher = getSharedRedisClient();
  }
  if (!progressPublisher) {
    throw new Error('Redis not configured — progress publishing requires Redis');
  }
  return progressPublisher;
}

/**
 * Publish progress event to Redis for all subscribers
 */
export async function publishProgressEvent(event: ProgressEvent): Promise<void> {
  try {
    const publisher = getProgressPublisher();
    const channel = `progress:${event.jobId}`;
    const message = JSON.stringify(event);
    await publisher.publish(channel, message);
    // Cache last event for replay to late-connecting clients
    await publisher.setex(`progress:last:${event.jobId}`, 3600, message);
    logger.info('Progress event published', {
      type: event.type,
      jobId: event.jobId,
    });
  } catch (error) {
    logger.error('Failed to publish progress event', {
      type: event.type,
      jobId: event.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Reset publisher on error so next call creates a fresh connection
    progressPublisher = null;
  }
}

/**
 * Get count of active subscriptions
 */
export function getActiveSubscriptions(): number {
  return activeSubscriptions.size;
}

/**
 * Cleanup all subscriptions (for graceful shutdown)
 */
export async function closeProgressSubscriptions(): Promise<void> {
  logger.info('Closing active WebSocket subscriptions', {
    count: activeSubscriptions.size,
  });

  for (const [key, subscription] of activeSubscriptions.entries()) {
    try {
      subscription.ws.close(1001, 'Server shutting down');
      await subscription.redis.quit();
      activeSubscriptions.delete(key);
    } catch (error) {
      logger.error('Error closing WebSocket subscription', {
        subscriptionKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Shared client — no need to close the publisher connection here.
  progressPublisher = null;
}
