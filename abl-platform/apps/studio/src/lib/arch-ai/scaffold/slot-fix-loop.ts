/**
 * Slot fix-loop — orchestrates the two LLM-side validation rings:
 *
 *   Ring 1: AI SDK structured output (JSON schema enforced at model layer)
 *   Ring 2: per-slot content validators (pure functions in slot-validators.ts)
 *
 * Ring 3 (compile + diagnostics) is handled by the caller after assembly.
 *
 * On a Ring-2 failure, re-prompts the LLM for ONLY the failing slot with
 * the validator's error message. If retries exhaust, falls back to a
 * bland-but-valid default and marks the slot in `fallbackSlots`.
 */

import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { CreativeContent, ScaffoldResult } from './types';
import {
  validateGoal,
  validatePersona,
  validateHandoffWhen,
  validateGatherAsk,
  validateCompleteWhen,
  validateCompleteRespond,
  type ValidationResult,
} from './slot-validators';

/**
 * Per-stage progress events emitted during fillSlots. Consumed by the worker
 * integration to surface state to the UI (SSE events) and to structured logs.
 */
export type FillProgress =
  | { kind: 'filling_start'; slotCount: number }
  | { kind: 'filling_complete'; slotCount: number; failingCount: number }
  | { kind: 'retrying_slot'; slot: string; attempt: number; maxAttempts: number; error: string }
  | { kind: 'slot_passed'; slot: string; attempts: number }
  | { kind: 'slot_fallback'; slot: string; reason: string }
  /**
   * Emitted every HEARTBEAT_INTERVAL_MS while a generateObject call is in
   * flight. Lets the caller keep SSE streams alive and show users a live
   * "model is thinking…" indicator during long reasoning-model calls.
   */
  | { kind: 'llm_tick'; phase: 'initial' | 'retry'; slot?: string; elapsedMs: number };

const HEARTBEAT_INTERVAL_MS = 10_000;
const GENERATE_OBJECT_TIMEOUT_MS = 45_000;

/**
 * Wrap a promise with a periodic heartbeat. The tick callback fires every
 * `intervalMs` until the promise resolves or rejects. Non-blocking — ticks
 * run on setInterval, cleaned up in finally.
 */
async function withHeartbeat<T>(
  promise: Promise<T>,
  intervalMs: number,
  onTick: (elapsedMs: number) => void,
): Promise<T> {
  const start = Date.now();
  const timer = setInterval(() => onTick(Date.now() - start), intervalMs);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

async function withHeartbeatAndTimeout<T>(
  promise: Promise<T>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    onTick: (elapsedMs: number) => void;
    timeoutMessage: string;
  },
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(options.timeoutMessage)), options.timeoutMs);
  });

  try {
    return await withHeartbeat(
      Promise.race([promise, timeoutPromise]),
      options.intervalMs,
      options.onTick,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export interface FillSlotsOptions {
  model: LanguageModel;
  /** Number of retries per individual slot before falling back to a default. */
  maxRetriesPerSlot: number;
  /** Worker/request abort signal. Aborts are terminal and must not fall back. */
  abortSignal?: AbortSignal;
  /** Optional progress callback for UI events + structured logging. */
  onProgress?: (event: FillProgress) => void;
}

export interface FillSlotsResult {
  creative: CreativeContent;
  slotAttempts: Record<string, number>;
  fallbackSlots: string[];
}

/**
 * Slots for which we have a reasonable bland default to use when all retries
 * fail. The default must pass its own validator.
 */
const FALLBACK_DEFAULTS: Record<string, string> = {
  goal: 'Help the user understand the request and provide a concise, useful next answer.',
  persona:
    'You are a professional assistant. You ask clear questions, explain choices in plain language, and keep replies concise, calm, and respectful. When the request is unclear or sensitive, ask for the minimum information needed and avoid exposing system decisions.',
};

const SAFE_FALLBACK_INTENT_CATEGORY = 'general';
const FORBIDDEN_FALLBACK_TOKENS = new Set([
  'routing',
  'classify',
  'classifies',
  'classifying',
  'route',
  'routes',
  'routed',
  'router',
  'routers',
  'escalate',
  'escalation',
  'escalated',
  'escalates',
  'escalating',
  'specialist',
  'specialists',
  'tool',
  'tools',
  'workflow',
  'workflows',
  'step',
  'steps',
  'context',
  'contexts',
  'retry',
  'retries',
  'retried',
  'retrying',
]);

export async function fillSlots(
  scaffold: ScaffoldResult,
  options: FillSlotsOptions,
): Promise<FillSlotsResult> {
  throwIfAborted(options.abortSignal);
  const slotAttempts: Record<string, number> = {};
  const fallbackSlots: string[] = [];
  const progress = options.onProgress ?? (() => {});

  // Ring 1 — initial structured-output call (with heartbeat so the caller
  // can keep its SSE stream alive during long reasoning-model responses)
  progress({ kind: 'filling_start', slotCount: 0 });
  let creative: CreativeContent;
  try {
    const first = await withHeartbeatAndTimeout(
      generateObject({
        model: options.model,
        schema: scaffold.creativeSchema,
        prompt: scaffold.prompt,
        abortSignal: options.abortSignal,
        timeout: { totalMs: GENERATE_OBJECT_TIMEOUT_MS },
      }),
      {
        timeoutMs: GENERATE_OBJECT_TIMEOUT_MS,
        intervalMs: HEARTBEAT_INTERVAL_MS,
        timeoutMessage: `Scaffold creative fill timed out after ${GENERATE_OBJECT_TIMEOUT_MS}ms`,
        onTick: (elapsedMs) => progress({ kind: 'llm_tick', phase: 'initial', elapsedMs }),
      },
    );
    creative = flattenCreative(first.object as Record<string, unknown>);
  } catch (err: unknown) {
    throwIfAborted(options.abortSignal);
    creative = buildFallbackCreative(scaffold);
    for (const slot of Object.keys(creative)) {
      fallbackSlots.push(slot);
      progress({
        kind: 'slot_fallback',
        slot,
        reason:
          err instanceof Error
            ? `initial_generation_failed: ${err.message}`
            : 'initial_generation_failed',
      });
    }
  }
  for (const key of Object.keys(creative)) slotAttempts[key] = 1;

  // Ring 2 — per-slot content validation + targeted re-prompt
  const gatherFieldNames = new Set(scaffold.skeleton.gatherFields.map((f) => f.name));
  const failing: string[] = [];
  for (const [slot, value] of Object.entries(creative)) {
    if (!validateSlot(slot, value, gatherFieldNames).ok) failing.push(slot);
  }
  progress({
    kind: 'filling_complete',
    slotCount: Object.keys(creative).length,
    failingCount: failing.length,
  });

  for (const slot of failing) {
    let passed = false;
    while ((slotAttempts[slot] ?? 1) < options.maxRetriesPerSlot + 1) {
      const currentValue = creative[slot];
      const validation = validateSlot(slot, currentValue, gatherFieldNames);
      if (validation.ok) {
        passed = true;
        break;
      }

      slotAttempts[slot] = (slotAttempts[slot] ?? 1) + 1;
      progress({
        kind: 'retrying_slot',
        slot,
        attempt: slotAttempts[slot],
        maxAttempts: options.maxRetriesPerSlot + 1,
        error: validation.error,
      });

      const retryPrompt = buildSlotRetryPrompt(
        scaffold.prompt,
        slot,
        currentValue,
        validation.error,
      );
      try {
        throwIfAborted(options.abortSignal);
        const retry = await withHeartbeatAndTimeout(
          generateObject({
            model: options.model,
            schema: buildSingleSlotSchema(slot),
            prompt: retryPrompt,
            abortSignal: options.abortSignal,
            timeout: { totalMs: GENERATE_OBJECT_TIMEOUT_MS },
          }),
          {
            timeoutMs: GENERATE_OBJECT_TIMEOUT_MS,
            intervalMs: HEARTBEAT_INTERVAL_MS,
            timeoutMessage: `Scaffold slot retry timed out after ${GENERATE_OBJECT_TIMEOUT_MS}ms`,
            onTick: (elapsedMs) => progress({ kind: 'llm_tick', phase: 'retry', slot, elapsedMs }),
          },
        );
        const retryObj = retry.object as Record<string, unknown>;
        const newValue = retryObj[slot];
        if (typeof newValue === 'string') {
          creative[slot] = newValue;
        }
      } catch {
        throwIfAborted(options.abortSignal);
        // Generation error — exit loop and fall through to fallback
        break;
      }
    }

    if (passed) {
      progress({ kind: 'slot_passed', slot, attempts: slotAttempts[slot] ?? 1 });
      continue;
    }

    if (!validateSlot(slot, creative[slot], gatherFieldNames).ok) {
      const fallback = FALLBACK_DEFAULTS[slot];
      if (fallback !== undefined) {
        creative[slot] = fallback;
        fallbackSlots.push(slot);
        progress({ kind: 'slot_fallback', slot, reason: 'retries_exhausted_use_default' });
      } else {
        fallbackSlots.push(slot);
        progress({ kind: 'slot_fallback', slot, reason: 'retries_exhausted_no_default' });
      }
    }
  }

  return { creative, slotAttempts, fallbackSlots };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw new Error('Scaffold generation aborted before completion.');
}

/**
 * Flatten nested `handoff`, `gather`, `complete` groups (produced by the Zod
 * schema) into dotted-path keys. A key like `handoff: { "0.when": "..." }`
 * becomes `"handoff.0.when": "..."` which matches the assembler's expected
 * CreativeContent shape.
 */
function flattenCreative(raw: Record<string, unknown>): CreativeContent {
  const out: CreativeContent = {};
  const NESTED_GROUPS = new Set(['handoff', 'gather', 'complete', 'tool']);

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (NESTED_GROUPS.has(key) && value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof subValue === 'string') {
          out[`${key}.${subKey}`] = subValue;
        }
      }
    }
  }

  return out;
}

function buildFallbackCreative(scaffold: ScaffoldResult): CreativeContent {
  const creative: CreativeContent = {
    goal: FALLBACK_DEFAULTS.goal,
    persona: FALLBACK_DEFAULTS.persona,
  };

  for (const handoff of scaffold.skeleton.handoffs) {
    if (handoff.whenSlot !== null) {
      creative[handoff.whenSlot] = `intent.category == "${toFallbackIntentCategory(handoff.to)}"`;
    }
  }

  for (const field of scaffold.skeleton.gatherFields) {
    creative[field.askSlot] =
      `What ${toFallbackQuestionSubject(field.name)} should I use for this request?`;
  }

  const gatherFieldNames = scaffold.skeleton.gatherFields
    .map((field) => field.name)
    .filter(isFallbackSafeIdentifier);
  for (const pair of scaffold.skeleton.completeSlots) {
    if (pair.whenSlot !== null) {
      creative[pair.whenSlot] =
        gatherFieldNames.length > 0
          ? gatherFieldNames.map((field) => `${field} != null`).join(' AND ')
          : 'true AND true';
    }
    if (pair.respondSlot !== null) {
      creative[pair.respondSlot] = 'Thanks, I have what I need now.';
    }
  }

  return creative;
}

function stripAgentSuffix(value: string): string {
  return value.replace(/(?:Agent|Specialist|Router|Desk|Coordinator|Stage)$/i, '');
}

function toFallbackIntentCategory(value: string): string {
  const tokens = toSnakeTokens(stripAgentSuffix(value)).filter(isFallbackSafeToken);
  return tokens.length > 0 ? tokens.join('_') : SAFE_FALLBACK_INTENT_CATEGORY;
}

function toFallbackQuestionSubject(value: string): string {
  const tokens = toSnakeTokens(value).filter(isFallbackSafeToken);
  return tokens.length > 0 ? tokens.join(' ') : 'information';
}

function toSnakeTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean);
}

function isFallbackSafeIdentifier(value: string): boolean {
  const tokens = toSnakeTokens(value);
  return tokens.length > 0 && tokens.every(isFallbackSafeToken);
}

function isFallbackSafeToken(value: string): boolean {
  return !FORBIDDEN_FALLBACK_TOKENS.has(value);
}

function validateSlot(
  slot: string,
  value: string,
  gatherFieldNames: ReadonlySet<string>,
): ValidationResult {
  if (slot === 'goal') return validateGoal(value);
  if (slot === 'persona') return validatePersona(value);
  if (slot.startsWith('handoff.') && slot.endsWith('.when')) return validateHandoffWhen(value);
  if (slot.startsWith('gather.') && slot.endsWith('.ask')) return validateGatherAsk(value);
  if (slot.startsWith('complete.') && slot.endsWith('.when')) {
    return validateCompleteWhen(value, gatherFieldNames);
  }
  if (slot.startsWith('complete.') && slot.endsWith('.respond'))
    return validateCompleteRespond(value);
  // Slots without a registered validator are accepted.
  return { ok: true };
}

function buildSlotRetryPrompt(
  basePrompt: string,
  slot: string,
  previousValue: string,
  errorMessage: string,
): string {
  return [
    basePrompt,
    '',
    `You previously produced this value for slot "${slot}":`,
    previousValue,
    '',
    `Validation failed: ${errorMessage}`,
    '',
    `Return JSON containing ONLY the corrected value for slot "${slot}" — no other slots.`,
  ].join('\n');
}

function buildSingleSlotSchema(slot: string): z.ZodTypeAny {
  return z.object({ [slot]: z.string() });
}
