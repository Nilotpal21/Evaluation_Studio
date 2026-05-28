/**
 * StoreResults — Restate activity service for persisting pipeline step outputs.
 *
 * Destinations:
 * - mongodb: Real write via mongoose.connection.collection()
 * - callback: Real HTTP POST via fetch()
 * - clickhouse: Stub (requires ClickHouse client dependency)
 */
import * as restate from '@restatedev/restate-sdk';
import mongoose from 'mongoose';
import { createLogger } from '@abl/compiler/platform';
import { resolveExpression } from '../expression-evaluator.js';
import {
  CUSTOM_PIPELINE_RESULTS_COLLECTION,
  CUSTOM_PIPELINE_RESULTS_TABLE,
} from '../contracts/destination-contract.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('store-results');

const CALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_SCORE_FIELD_CANDIDATES = ['overallScore', 'score', 'rating', 'value', 'confidence'];

interface CallbackStoreResult {
  ok: boolean;
  recordsWritten?: number;
  error?: string;
}

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeExpressionPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function getSourceStepOutput(input: PipelineStepContext): {
  sourceStepId: string | undefined;
  sourceStep: StepOutput | undefined;
  outputPayload: unknown;
} {
  const sourceStepId = input.config.sourceStep as string | undefined;
  const sourceStep = sourceStepId ? input.previousSteps[sourceStepId] : undefined;
  const outputPayload = sourceStepId ? (sourceStep?.data ?? {}) : input.previousSteps;
  return { sourceStepId, sourceStep, outputPayload };
}

function resolveConfiguredPayload(
  input: PipelineStepContext,
  path: unknown,
  fallback: unknown,
): unknown {
  if (typeof path !== 'string' || path.trim() === '') return fallback;
  return resolveExpression(normalizeExpressionPath(path), input.previousSteps, input.pipelineInput);
}

function resolveScoreSelection(input: PipelineStepContext): {
  scoreName: string;
  scorePath: string;
  scoreValue: number | null;
} {
  const configuredPath = input.config.scorePath;
  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    const normalizedPath = normalizeExpressionPath(configuredPath);
    const value = resolveExpression(normalizedPath, input.previousSteps, input.pipelineInput);
    return {
      scoreName:
        (input.config.scoreName as string | undefined)?.trim() ||
        normalizedPath.split('.').at(-1) ||
        'overallScore',
      scorePath: normalizedPath,
      scoreValue: typeof value === 'number' && Number.isFinite(value) ? value : null,
    };
  }

  const { outputPayload } = getSourceStepOutput(input);
  if (typeof outputPayload === 'number' && Number.isFinite(outputPayload)) {
    return { scoreName: 'score', scorePath: '', scoreValue: outputPayload };
  }

  if (outputPayload && typeof outputPayload === 'object' && !Array.isArray(outputPayload)) {
    const payload = outputPayload as Record<string, unknown>;
    for (const field of DEFAULT_SCORE_FIELD_CANDIDATES) {
      const value = payload[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { scoreName: field, scorePath: field, scoreValue: value };
      }
    }
  }

  return {
    scoreName: (input.config.scoreName as string | undefined)?.trim() || 'overallScore',
    scorePath:
      typeof input.config.scorePath === 'string'
        ? normalizeExpressionPath(input.config.scorePath)
        : '',
    scoreValue: null,
  };
}

function buildSharedClickHouseRow(
  input: PipelineStepContext,
  source: string,
): Record<string, unknown> {
  const { sourceStepId, sourceStep } = getSourceStepOutput(input);
  const score = resolveScoreSelection(input);

  return {
    tenant_id: input.tenantId,
    project_id: input.projectId ?? '',
    pipeline_id: input.pipelineId ?? (input.pipelineInput?.pipelineId as string) ?? '',
    pipeline_name: input.pipelineName ?? (input.pipelineInput?.pipelineName as string) ?? '',
    pipeline_kind: input.pipelineType ?? 'custom',
    run_id: (input.pipelineInput?.runId as string) ?? '',
    session_id: input.sessionId ?? '',
    store_step_id: input.stepId ?? '',
    source_step_id: sourceStepId ?? '',
    source_step_status: sourceStep?.status ?? '',
    trigger_id: input.triggerId ?? '',
    execution_mode: input.executionMode ?? 'batch',
    source,
    score_name: score.scoreName,
    score_path: score.scorePath,
    score_value: score.scoreValue,
    output_json: stableJson({ [score.scoreName]: score.scoreValue }),
    created_at: toCHDateTime(new Date()),
  };
}

function buildSharedMongoDocument(
  input: PipelineStepContext,
  source: string,
): Record<string, unknown> {
  const { sourceStepId, sourceStep, outputPayload } = getSourceStepOutput(input);
  const documentPayload = resolveConfiguredPayload(input, input.config.documentPath, outputPayload);

  return {
    tenantId: input.tenantId,
    projectId: input.projectId ?? '',
    pipelineId: input.pipelineId ?? (input.pipelineInput?.pipelineId as string) ?? '',
    pipelineName: input.pipelineName ?? (input.pipelineInput?.pipelineName as string) ?? '',
    pipelineKind: input.pipelineType ?? 'custom',
    runId: (input.pipelineInput?.runId as string) ?? '',
    sessionId: input.sessionId ?? '',
    storeStepId: input.stepId ?? '',
    sourceStepId: sourceStepId ?? '',
    sourceStepStatus: sourceStep?.status ?? '',
    triggerId: input.triggerId ?? '',
    executionMode: input.executionMode ?? 'batch',
    source,
    output: documentPayload,
    createdAt: new Date(),
  };
}

function buildSharedMongoDocumentId(input: PipelineStepContext): string {
  return [
    (input.pipelineInput?.runId as string) || 'no-run',
    input.pipelineId ?? (input.pipelineInput?.pipelineId as string) ?? 'no-pipeline',
    input.stepId ?? 'store-results',
    (input.config.sourceStep as string | undefined) ?? 'all',
    input.sessionId ?? 'no-session',
  ].join(':');
}

/** Alphanumeric, underscores, hyphens. 1-64 chars. Must start with letter or underscore. */
const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/** Validate callback URL (same SSRF protection as SendNotification). */
function validateCallbackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid callback URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Callback URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal';
  if (blocked && process.env.NODE_ENV === 'production') {
    throw new Error(`Callback URL blocked: private/reserved address: ${hostname}`);
  }
}

/** Build document from template (resolve expressions) or default (all step outputs). */
function buildDocument(
  input: PipelineStepContext,
  template?: Record<string, string>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  if (template && typeof template === 'object') {
    for (const [key, value] of Object.entries(template)) {
      if (
        typeof value === 'string' &&
        (value.startsWith('steps.') || value.startsWith('pipelineInput.'))
      ) {
        doc[key] = resolveExpression(value, input.previousSteps, input.pipelineInput);
      } else {
        doc[key] = value;
      }
    }
  } else {
    doc.stepOutputs = input.previousSteps;
    doc.pipelineInput = input.pipelineInput;
    doc.projectId = input.projectId;
    doc.sessionId = input.sessionId;
  }

  // Always include tenantId and timestamp for isolation and auditability
  doc.tenantId = input.tenantId;
  doc.createdAt = new Date();
  return doc;
}

function resolveStorageStrategy(input: PipelineStepContext): string | undefined {
  const strategy = input.config.storageStrategy;
  return typeof strategy === 'string' && strategy.trim() ? strategy : undefined;
}

async function writeSharedClickHouseScore(
  input: PipelineStepContext,
  source: string,
): Promise<number> {
  const row = buildSharedClickHouseRow(input, source);

  // Add real-time metadata when in realtime mode.
  if (input.executionMode === 'realtime') {
    row.trigger_id = input.triggerId ?? '';
    row.message_index =
      (input.pipelineInput?.payload as Record<string, unknown>)?.messageIndex ?? 0;
    const readWindowOutput = Object.values(input.previousSteps).find(
      (s) => s.data?.metadata?.windowSize !== undefined,
    );
    row.window_size = readWindowOutput?.data?.metadata?.windowSize ?? 0;
  }

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();
  await client.insert({
    table: CUSTOM_PIPELINE_RESULTS_TABLE,
    values: [row],
    format: 'JSONEachRow',
  });

  return 1;
}

async function writeSharedMongoDocument(
  input: PipelineStepContext,
  source: string,
): Promise<number> {
  const collectionName =
    (input.config.collection as string | undefined) ?? CUSTOM_PIPELINE_RESULTS_COLLECTION;
  if (!COLLECTION_NAME_RE.test(collectionName)) {
    throw new Error(`Invalid collection name: '${collectionName}'`);
  }

  const document = buildSharedMongoDocument(input, source);
  const docId = buildSharedMongoDocumentId(input);
  document._id = docId;

  const collection = mongoose.connection.collection(collectionName);
  await collection.updateOne(
    { _id: docId as unknown as mongoose.Types.ObjectId },
    { $setOnInsert: document },
    { upsert: true },
  );
  return 1;
}

export const storeResultsService = restate.service({
  name: 'StoreResults',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const { destination, callbackUrl } = input.config;
      const sessionId = input.sessionId;
      const runId = input.pipelineInput?.runId as string | undefined;

      log.debug('Store results executing', {
        sessionId,
        runId,
        pipelineId: input.pipelineId,
        destination: destination ?? 'none',
      });

      try {
        const storageStrategy = resolveStorageStrategy(input);
        // When no destination is configured, skip gracefully.
        // Built-in compute steps (sentiment, quality, intent, etc.) already
        // persist their own results directly to ClickHouse, so the generic
        // store-results step is only needed for custom/callback destinations.
        if (!destination && !storageStrategy) {
          return {
            status: 'skipped',
            data: { reason: 'No destination configured; compute step handles persistence' },
            durationMs: Date.now() - startTime,
          };
        }

        let recordsWritten = 0;
        const source = (input.config.source as string) ?? 'batch';

        if (storageStrategy === 'score_and_document') {
          const scoreWrites = await ctx.run('store-clickhouse-score', async () =>
            writeSharedClickHouseScore(input, source),
          );
          const documentWrites = await ctx.run('store-mongodb-document', async () =>
            writeSharedMongoDocument(input, source),
          );
          recordsWritten = scoreWrites + documentWrites;
        } else if (storageStrategy === 'score_only') {
          recordsWritten = await ctx.run('store-clickhouse-score', async () =>
            writeSharedClickHouseScore(input, source),
          );
        } else if (storageStrategy === 'document_only') {
          recordsWritten = await ctx.run('store-mongodb-document', async () =>
            writeSharedMongoDocument(input, source),
          );
        }

        if (storageStrategy) {
          log.debug('Store results succeeded', {
            sessionId,
            runId,
            pipelineId: input.pipelineId,
            destination: storageStrategy,
            recordsWritten,
            durationMs: Date.now() - startTime,
          });

          return {
            status: 'success',
            data: { recordsWritten, destination: storageStrategy },
            durationMs: Date.now() - startTime,
          };
        }

        switch (destination) {
          case 'clickhouse':
            recordsWritten = await ctx.run('store-clickhouse', async () => {
              const table =
                (input.config.table as string | undefined) ?? CUSTOM_PIPELINE_RESULTS_TABLE;

              const row: Record<string, unknown> =
                table === CUSTOM_PIPELINE_RESULTS_TABLE
                  ? buildSharedClickHouseRow(input, source)
                  : {
                      ...(input.config.sourceStep
                        ? (input.previousSteps[input.config.sourceStep as string]?.data ?? {})
                        : {}),
                      tenant_id: input.tenantId,
                      project_id: input.projectId ?? '',
                      session_id: input.sessionId ?? '',
                      run_id: (input.pipelineInput?.runId as string) ?? '',
                      pipeline_id:
                        input.pipelineId ?? (input.pipelineInput?.pipelineId as string) ?? '',
                      source,
                      created_at: toCHDateTime(new Date()),
                    };

              // Add real-time metadata when in realtime mode
              if (input.executionMode === 'realtime') {
                row.trigger_id = input.triggerId ?? '';
                row.message_index =
                  (input.pipelineInput?.payload as Record<string, unknown>)?.messageIndex ?? 0;
                // Get window size from read-message-window output
                const readWindowOutput = Object.values(input.previousSteps).find(
                  (s) => s.data?.metadata?.windowSize !== undefined,
                );
                row.window_size = readWindowOutput?.data?.metadata?.windowSize ?? 0;
              }

              const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
              const client = getClickHouseClient();
              await client.insert({
                table,
                values: [row],
                format: 'JSONEachRow',
              });

              return 1;
            });
            break;

          case 'mongodb':
            recordsWritten = await ctx.run('store-mongodb', async () => {
              const collectionName =
                (input.config.collection as string | undefined) ??
                (input.config.table as string | undefined) ??
                CUSTOM_PIPELINE_RESULTS_COLLECTION;
              if (!COLLECTION_NAME_RE.test(collectionName)) {
                throw new Error(`Invalid collection name: '${collectionName}'`);
              }

              const usingSharedCollection = collectionName === CUSTOM_PIPELINE_RESULTS_COLLECTION;
              const source = (input.config.source as string) ?? 'batch';
              const document = usingSharedCollection
                ? buildSharedMongoDocument(input, source)
                : buildDocument(input, input.config.document as Record<string, string> | undefined);

              // Deterministic _id for Restate replay idempotency
              const runId = (input.pipelineInput?.runId as string) ?? '';
              const docId = usingSharedCollection
                ? buildSharedMongoDocumentId(input)
                : `${runId}:${collectionName}:${input.sessionId ?? ''}`;
              document._id = docId;

              const collection = mongoose.connection.collection(collectionName);
              await collection.updateOne(
                { _id: docId as unknown as mongoose.Types.ObjectId },
                { $setOnInsert: document },
                { upsert: true },
              );
              return 1;
            });
            break;

          case 'callback':
            {
              const callbackResult = await ctx.run(
                'store-callback',
                async (): Promise<CallbackStoreResult> => {
                  if (!callbackUrl) {
                    throw new Error('Callback destination requires callbackUrl');
                  }
                  validateCallbackUrl(callbackUrl as string);

                  const body = {
                    tenantId: input.tenantId,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    stepOutputs: input.previousSteps,
                    timestamp: new Date().toISOString(),
                  };

                  // Idempotency key for Restate replay safety
                  const cbRunId = (input.pipelineInput?.runId as string) ?? '';
                  const idempotencyKey = `${cbRunId}:callback:${input.sessionId ?? ''}`;

                  try {
                    const response = await fetch(callbackUrl as string, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Idempotency-Key': idempotencyKey,
                      },
                      body: JSON.stringify(body),
                      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
                    });

                    if (!response.ok) {
                      return {
                        ok: false,
                        error: `Callback returned ${response.status}: ${response.statusText}`,
                      };
                    }
                  } catch (error) {
                    return {
                      ok: false,
                      error: error instanceof Error ? error.message : String(error),
                    };
                  }

                  return { ok: true, recordsWritten: 1 };
                },
              );

              if (!callbackResult.ok) {
                return {
                  status: 'fail',
                  data: { error: callbackResult.error ?? 'Callback delivery failed' },
                  durationMs: Date.now() - startTime,
                };
              }

              recordsWritten = callbackResult.recordsWritten ?? 1;
            }
            break;

          default:
            return {
              status: 'fail',
              data: { error: `Unknown destination: '${destination}'` },
              durationMs: Date.now() - startTime,
            };
        }

        log.debug('Store results succeeded', {
          sessionId,
          runId,
          pipelineId: input.pipelineId,
          destination,
          recordsWritten,
          durationMs: Date.now() - startTime,
        });

        return {
          status: 'success',
          data: { recordsWritten, destination },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Store results failed', {
          sessionId,
          runId,
          pipelineId: input.pipelineId,
          destination: destination ?? 'none',
          error: msg,
        });
        return {
          status: 'fail',
          data: {
            error: msg,
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type StoreResultsService = typeof storeResultsService;
