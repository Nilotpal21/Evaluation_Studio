/**
 * Feedback list (read) — companion to the in-chat feedback capture path
 * landed under ABLP-1068.
 *
 * Mounted at `/api/projects/:projectId/feedback`. Reads from
 * `abl_platform.feedback`, runs the ClickHouseEncryptionInterceptor's
 * `afterQuery` to decrypt `feedback_text`, and serves a cursor-paginated
 * list backing the Studio Insights → Feedback viewer.
 *
 * Authorization piggybacks on `analytics:read` via
 * `requireProjectWideAnalyticsAccess` — feedback is part of the same
 * Insights surface and shares the existing role/permission contract.
 *
 * Cross-tenant or cross-project access returns 404 (handled by
 * `requireProjectScope`'s `concealOutOfScope`).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectWideAnalyticsAccess } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('feedback-list-route');

const RATING_TYPES = ['thumbs', 'star', 'text'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_RANGE_DAYS = 30;

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agentName: z.string().min(1).max(200).optional(),
  channel: z.string().min(1).max(64).optional(),
  ratingType: z.enum(RATING_TYPES).optional(),
  ratingValue: z.coerce.number().finite().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  messageId: z.string().min(1).max(200).optional(),
  hasText: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

interface FeedbackListRow {
  feedback_id: string;
  tenant_id: string;
  project_id: string;
  timestamp: string;
  session_id: string;
  message_id: string;
  agent_name: string;
  user_id: string;
  channel: string;
  rating_type: string;
  rating_value: number | string;
  feedback_text: string;
  has_pii: number | string;
  encrypted: number | string;
  source: string;
  ingress_type: string;
  _enc?: string;
}

interface FeedbackListItem {
  feedbackId: string;
  timestamp: string;
  sessionId: string;
  messageId: string;
  agentName: string;
  channel: string;
  ratingType: string;
  ratingValue: number;
  feedbackText: string;
  hasText: boolean;
  source: string;
  ingress: string;
}

function decodeCursor(cursor: string): { timestamp: string; feedbackId: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const timestamp = decoded.slice(0, sep);
    const feedbackId = decoded.slice(sep + 1);
    if (!timestamp || !feedbackId) return null;
    return { timestamp, feedbackId };
  } catch {
    return null;
  }
}

function encodeCursor(timestamp: string, feedbackId: string): string {
  return Buffer.from(`${timestamp}|${feedbackId}`, 'utf8').toString('base64');
}

function defaultTimeRange(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000),
    to: now,
  };
}

async function getClickHouseDeps() {
  try {
    const clickhouse = await import('@agent-platform/database/clickhouse');
    const client = clickhouse.getClickHouseClient();
    if (!client) return null;
    return {
      client,
      toClickHouseDateTime: clickhouse.toClickHouseDateTime,
    };
  } catch {
    return null;
  }
}

async function decryptFeedbackRows(rows: FeedbackListRow[]): Promise<FeedbackListRow[]> {
  if (rows.length === 0) return rows;
  const hasEncrypted = rows.some((row) => typeof row._enc === 'string' && row._enc.length > 0);
  if (!hasEncrypted) return rows;
  try {
    const { getClickHouseEncryptionInterceptor } =
      await import('../services/stores/clickhouse-encryption-singleton.js');
    const interceptor = getClickHouseEncryptionInterceptor();
    if (!interceptor) return rows;
    const decrypted = await interceptor.afterQuery(
      'feedback',
      rows as unknown as Record<string, unknown>[],
    );
    return decrypted as unknown as FeedbackListRow[];
  } catch (err) {
    log.warn('Failed to decrypt feedback rows', {
      rowCount: rows.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return rows;
  }
}

function toListItem(row: FeedbackListRow): FeedbackListItem {
  const ratingValue =
    typeof row.rating_value === 'number'
      ? row.rating_value
      : Number.parseFloat(String(row.rating_value)) || 0;
  return {
    feedbackId: row.feedback_id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    messageId: row.message_id,
    agentName: row.agent_name ?? '',
    channel: row.channel ?? '',
    ratingType: row.rating_type,
    ratingValue,
    feedbackText: row.feedback_text ?? '',
    hasText: (row.feedback_text ?? '').length > 0,
    source: row.source ?? '',
    ingress: row.ingress_type ?? '',
  };
}

function getTenantIdOrRespond(req: Request, res: Response): string | null {
  const ctx = (req as Request & { tenantContext?: { tenantId?: string } }).tenantContext;
  const tenantId = ctx?.tenantId;
  if (!tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return null;
  }
  return tenantId;
}

const openapi: { router: RouterType } = { router: Router({ mergeParams: true }) };
const router: RouterType = openapi.router;
router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) {
      return;
    }
    const tenantId = getTenantIdOrRespond(req, res);
    if (!tenantId) return;
    const { projectId } = req.params as { projectId: string };

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_QUERY',
          message: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
        },
      });
      return;
    }
    const q = parsed.data;

    const deps = await getClickHouseDeps();
    if (!deps) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Feedback database unavailable' },
      });
      return;
    }

    const range =
      q.from || q.to
        ? {
            from: q.from ? new Date(q.from) : defaultTimeRange().from,
            to: q.to ? new Date(q.to) : new Date(),
          }
        : defaultTimeRange();
    const fromCh = deps.toClickHouseDateTime(range.from);
    const toCh = deps.toClickHouseDateTime(range.to);

    const limit = q.limit ?? DEFAULT_LIMIT;
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;

    const params: Record<string, unknown> = {
      tenantId,
      projectId,
      from: fromCh,
      to: toCh,
      limit: limit + 1, // fetch one extra to detect "has next page"
    };
    const where: string[] = [
      'tenant_id = {tenantId:String}',
      'project_id = {projectId:String}',
      'timestamp >= {from:DateTime64(3)}',
      'timestamp <= {to:DateTime64(3)}',
    ];

    if (q.agentName) {
      params.agentName = q.agentName;
      where.push('agent_name = {agentName:String}');
    }
    if (q.channel) {
      params.channel = q.channel;
      where.push('channel = {channel:String}');
    }
    if (q.ratingType) {
      params.ratingType = q.ratingType;
      where.push('rating_type = {ratingType:String}');
    }
    if (typeof q.ratingValue === 'number') {
      params.ratingValue = q.ratingValue;
      where.push('rating_value = {ratingValue:Float32}');
    }
    if (q.sessionId) {
      params.sessionId = q.sessionId;
      where.push('session_id = {sessionId:String}');
    }
    if (q.messageId) {
      params.messageId = q.messageId;
      where.push('message_id = {messageId:String}');
    }
    if (typeof q.hasText === 'boolean') {
      if (q.hasText) {
        where.push('has_pii = 1');
      } else {
        where.push('has_pii = 0');
      }
    }
    if (cursor) {
      params.cursorTs = cursor.timestamp;
      params.cursorId = cursor.feedbackId;
      // ORDER BY timestamp DESC, feedback_id DESC — paginate to "older" rows.
      where.push(
        '(timestamp < {cursorTs:DateTime64(3)} OR (timestamp = {cursorTs:DateTime64(3)} AND feedback_id < {cursorId:String}))',
      );
    }

    const sql = `
      SELECT
        feedback_id, tenant_id, project_id, timestamp, session_id, message_id,
        agent_name, user_id, channel, rating_type, rating_value, feedback_text,
        has_pii, encrypted, source, ingress_type, _enc
      FROM abl_platform.feedback
      WHERE ${where.join(' AND ')}
      ORDER BY timestamp DESC, feedback_id DESC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 15
    `;

    const result = await deps.client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as FeedbackListRow[];

    const decrypted = await decryptFeedbackRows(rows);
    const hasMore = decrypted.length > limit;
    const page = hasMore ? decrypted.slice(0, limit) : decrypted;
    const items = page.map(toListItem);
    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor(page[page.length - 1]!.timestamp, page[page.length - 1]!.feedback_id)
        : null;

    res.json({
      success: true,
      data: {
        items,
        nextCursor,
      },
    });
  } catch (err) {
    log.error('Feedback list query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load feedback' },
    });
  }
});

export default router;
