/**
 * Feedback service — single point that validates, dedups, and persists user
 * feedback on assistant messages.
 *
 * Two WS ingresses fan in here:
 *   • `feedback.submit` (dedicated, structured)
 *   • `action_submit(actionId='feedback')` (rich-template renderer)
 * Both ingresses are normalised to `FeedbackSubmission` before reaching this
 * service (see `./types.ts`).
 *
 * Side effects per accepted submission:
 *   1. CH insert into `abl_platform.feedback` (encrypted at rest via the
 *      shared ClickHouseEncryptionInterceptor — feedback_text lives ONLY
 *      here, per PII storage policy in LLD D-12).
 *   2. EventStore emit of `feedback.submitted` with PII-minimised payload
 *      (has_feedback_text + feedback_text_length only — never raw text).
 *   3. TraceStore broadcast with the same PII-minimised shape for live UI.
 *
 * Dependencies are constructor-injected so unit tests can exercise the
 * service without mocking platform components.
 */

import { randomUUID } from 'crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  BufferedClickHouseWriter,
  type BufferedWriterOptions,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import { ClickHouseEncryptionInterceptor } from '@agent-platform/database';
import type { MessageStore } from '@abl/compiler/platform/stores/message-store.js';
import type { EventStoreServices } from '@abl/eventstore';
import { EVENT_CATEGORIES } from '@abl/eventstore';
import { scrubSecrets } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { TraceEvent } from '@agent-platform/shared-kernel';

import { acquireDedupSlot, releaseDedupSlot, type RedisLikeClient } from './dedup.js';
import { resolveTarget } from './agent-attribution.js';
import type { FeedbackRecord, FeedbackSubmission, SubmitContext, SubmitResult } from './types.js';

const log = createLogger('feedback-service');

const FEEDBACK_TABLE = 'abl_platform.feedback';

/**
 * Wire-level row layout, mirroring the CH DDL columns in
 * `packages/database/src/clickhouse-schemas/init.ts`. Plaintext goes in;
 * the encryption interceptor handles `feedback_text` at flush time.
 */
interface FeedbackRow {
  tenant_id: string;
  project_id: string;
  feedback_id: string;
  timestamp: string;
  session_id: string;
  message_id: string;
  agent_name: string;
  user_id: string;
  channel: string;
  rating_type: string;
  rating_value: number;
  feedback_text: string;
  has_pii: number;
  encrypted: number;
  key_version: number;
  source: string;
  ingress_type: string;
}

/**
 * Trace event shape the feedback service produces — superset of the canonical
 * `TraceEvent` so it satisfies the runtime's storage-extended variant
 * (`apps/runtime/src/services/trace-store.ts` adds required `id` + `sessionId`
 * fields). Keeping the shape local to the service avoids importing the
 * runtime-only type from the canonical-typed @agent-platform/shared-kernel.
 */
export interface FeedbackTraceEvent extends TraceEvent {
  id: string;
  sessionId: string;
}

/**
 * Minimal TraceStore surface the feedback service uses — DI-friendly so unit
 * tests can pass a fake without depending on the runtime singleton.
 */
export interface TraceStoreLike {
  addEvent(sessionId: string, event: FeedbackTraceEvent): void | Promise<void>;
}

export interface FeedbackServiceDeps {
  /** Storage-agnostic lookup for the target message. */
  messageStore: MessageStore;
  /** ClickHouse client used by the buffered writer. */
  clickhouseClient: ClickHouseClient;
  /** Optional encryption interceptor. Pass null/undefined to write plaintext. */
  encryptionInterceptor?: ClickHouseEncryptionInterceptor | null;
  /** Optional Redis client for dedup; null → soft-allow. */
  redis: RedisLikeClient | null;
  /** Optional EventStore — null = no durable emit (TraceStore still fires). */
  eventStore: EventStoreServices | null;
  /** Optional TraceStore — null = no live broadcast. */
  traceStore: TraceStoreLike | null;
  /** Override writer options (test hook — keep batch=1 + flushInterval small). */
  writerOptionsOverride?: Partial<BufferedWriterOptions>;
  /** Test seam for the row timestamp / feedback id; defaults to randomUUID() + Date. */
  clock?: () => Date;
  idGenerator?: () => string;
}

export interface FeedbackSubmitInput extends FeedbackSubmission, SubmitContext {}

export class FeedbackService {
  private readonly deps: FeedbackServiceDeps;
  private readonly writer: BufferedClickHouseWriter<FeedbackRow>;
  private readonly clock: () => Date;
  private readonly id: () => string;

  constructor(deps: FeedbackServiceDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
    this.id = deps.idGenerator ?? randomUUID;
    this.writer = new BufferedClickHouseWriter<FeedbackRow>(deps.clickhouseClient, {
      table: FEEDBACK_TABLE,
      encryptionInterceptor: deps.encryptionInterceptor ?? undefined,
      // Feedback writes are individually awaited via explicit flush() — set
      // batchSize high enough that the writer's auto-flush (which swallows
      // errors via onError) never fires on a single row. The service relies
      // on flush() throwing to surface STORAGE_FAILURE to callers.
      batchSize: 200,
      flushIntervalMs: 1000,
      // Suppress the writer's console.error output — our service-level log
      // line below carries the same information with feedback context.
      suppressErrorLogs: true,
      ...(deps.writerOptionsOverride ?? {}),
      onError: (err, ctx) => {
        log.error('Feedback CH flush error', {
          error: err instanceof Error ? err.message : String(err),
          context: ctx,
        });
      },
    });
  }

  async close(): Promise<void> {
    await this.writer.flush().catch(() => {
      /* swallow */
    });
  }

  async submit(input: FeedbackSubmitInput): Promise<SubmitResult> {
    // ── A: target lookup + agent attribution ────────────────────────────
    const target = await resolveTarget(
      this.deps.messageStore,
      input.tenantId,
      input.projectId,
      input.sessionId,
      input.messageId,
    );
    if (!target) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        message: 'Target message not found in this session',
      };
    }
    if (target.message.role !== 'assistant') {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        message: 'Feedback can only be submitted on assistant messages',
      };
    }

    // ── B: dedup ────────────────────────────────────────────────────────
    const dedupCtx = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      userId: input.userId,
    };
    const dedup = await acquireDedupSlot(this.deps.redis, dedupCtx);
    if (!dedup.acquired) {
      return {
        ok: false,
        code: 'DUPLICATE_FEEDBACK',
        message: 'Feedback already submitted for this message',
      };
    }

    // ── C: build the row ───────────────────────────────────────────────
    const feedbackId = this.id();
    const now = this.clock();
    const hasFeedbackText = !!input.feedbackText && input.feedbackText.length > 0;
    const encryptionConfigured = !!this.deps.encryptionInterceptor;
    const row: FeedbackRow = {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      feedback_id: feedbackId,
      // DateTime64(3) wants "YYYY-MM-DD HH:MM:SS.mmm" — JSONEachRow rejects
      // the ISO Z/T form.
      timestamp: toClickHouseDateTime(now),
      session_id: input.sessionId,
      message_id: input.messageId,
      agent_name: target.agentName,
      user_id: input.userId,
      channel: input.channel ?? '',
      rating_type: input.ratingType,
      rating_value: input.ratingValue,
      feedback_text: input.feedbackText ?? '',
      has_pii: hasFeedbackText ? 1 : 0,
      // `encrypted` / `key_version` reflect interceptor state — when no
      // interceptor is configured the row lands at 0/0 (plaintext default).
      // With an interceptor, the columns track key version v1 today.
      encrypted: encryptionConfigured ? 1 : 0,
      key_version: encryptionConfigured ? 1 : 0,
      source: 'websocket',
      ingress_type: input.ingress,
    };

    // ── D: persist ──────────────────────────────────────────────────────
    try {
      this.writer.insert(row);
      // Force flush so a) callers get a stable feedbackId-bound ack rather
      // than an in-buffer write and b) downstream emits don't fire ahead of
      // the row landing in CH.
      await this.writer.flush();
    } catch (err) {
      log.error('Feedback CH insert failed', {
        feedbackId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await releaseDedupSlot(this.deps.redis, dedupCtx);
      return { ok: false, code: 'STORAGE_FAILURE', message: 'Failed to persist feedback' };
    }

    // ── E: EventStore emit (PII-minimised) ──────────────────────────────
    if (this.deps.eventStore) {
      try {
        const piiMinimisedData = scrubSecrets({
          rating_type: input.ratingType,
          rating_value: input.ratingValue,
          target_message_id: input.messageId,
          has_feedback_text: hasFeedbackText,
          feedback_text_length: input.feedbackText?.length ?? 0,
          ingress: input.ingress,
        });
        this.deps.eventStore.emitter.emit({
          event_id: feedbackId,
          event_type: 'feedback.submitted',
          category: EVENT_CATEGORIES.FEEDBACK,
          tenant_id: input.tenantId,
          project_id: input.projectId,
          session_id: input.sessionId,
          trace_id: input.sessionId,
          agent_name: target.agentName,
          timestamp: now,
          data: piiMinimisedData,
        });
      } catch (err) {
        // EventStore emit is fire-and-forget — never fail the ack on it.
        log.warn('Feedback EventStore emit failed', {
          feedbackId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── F: TraceStore broadcast (live) ──────────────────────────────────
    if (this.deps.traceStore) {
      try {
        this.deps.traceStore.addEvent(input.sessionId, {
          id: feedbackId,
          sessionId: input.sessionId,
          type: 'feedback.submitted' as TraceEvent['type'],
          timestamp: now,
          agentName: target.agentName,
          data: {
            feedback_id: feedbackId,
            rating_type: input.ratingType,
            rating_value: input.ratingValue,
            target_message_id: input.messageId,
            has_feedback_text: hasFeedbackText,
            feedback_text_length: input.feedbackText?.length ?? 0,
          },
        });
      } catch (err) {
        log.warn('Feedback TraceStore broadcast failed', {
          feedbackId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Feedback captured', {
      feedbackId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      ratingType: input.ratingType,
      ratingValue: input.ratingValue,
      ingress: input.ingress,
      softAllowed: dedup.softAllowed,
    });

    return { ok: true, feedbackId };
  }
}

/**
 * Sanity-check exported for tests — never the public path. The persisted row
 * layout mirrors the LLD §2.6 contract.
 */
export type { FeedbackRow };
/** Re-exported here so consumers can import the persistence shape from one place. */
export type { FeedbackRecord };
