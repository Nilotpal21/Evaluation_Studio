/**
 * Arch AI v2 turn-event envelope and schema.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.4.
 * Every SSE frame on the Arch v4 SSE surfaces is a TurnEvent or a SessionSignal
 * (via the fan-out channel).
 *
 * Convention: Zod schemas are canonical; TypeScript types are derived via `z.infer`.
 *
 * Types referenced below but NOT declared here are imported from existing packages
 * and remain out of scope for this redesign (per spec §1 "Out of scope"):
 *   - Topology, JournalEntry, HealthReport, TraceResult, DiagnosticReport, InsightPanel
 *   - GateData, ArchContentBlock, Phase
 * On the wire they travel as `z.unknown()` payloads; strong typing is reasserted at the
 * consumer (WidgetRenderer, BuildProgressCard, etc.).
 */

import { z } from 'zod';

// ─── Envelope ────────────────────────────────────────────────────────────

/**
 * Every event carries this envelope. Fields are ordered for stable JSON serialization.
 * `schemaVersion: 2` discriminates v2 events from any future v3 that may ship later.
 */
export const EnvelopeSchema = z.object({
  /** ULID, unique across all events globally. */
  eventId: z.string().min(1),
  /** Protocol version — v2 is the post-redesign baseline. */
  schemaVersion: z.literal(2),
  /** Session this event belongs to. */
  sessionId: z.string().min(1),
  /** Turn within the session. `turnId` is stable across a single LLM round-trip. */
  turnId: z.string().min(1),
  /** Monotonic counter within a turn (starts at 0). */
  seq: z.number().int().nonnegative(),
  /**
   * Monotonic durable replay cursor across the session.
   * Present only on durable events stored in the reconnect ring buffer.
   */
  replaySeq: z.number().int().nonnegative().optional(),
  /** Unix ms epoch (UTC). */
  timestamp: z.number().int().nonnegative(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

// ─── Supporting interfaces ───────────────────────────────────────────────

/** Progress breadcrumb for multi-step internal work (e.g., BUILD aggregator). */
export const ActivityStepSchema = z.object({
  groupId: z.string().min(1),
  stepId: z.string().min(1),
  state: z.enum(['start', 'progress', 'end']),
  status: z.enum(['active', 'done', 'error', 'warning', 'info']).optional(),
  label: z.string().optional(),
  groupLabel: z.string().optional(),
  detail: z.string().optional(),
});
export type ActivityStep = z.infer<typeof ActivityStepSchema>;

/**
 * Per-agent build state. Consumed by BuildProgressCard which renders the
 * 3-column {gen, comp, enrich, done} stage grid plus quality pills.
 */
export const AgentBuildStageSchema = z.enum(['pending', 'active', 'done', 'error']);
export type AgentBuildStage = z.infer<typeof AgentBuildStageSchema>;

export const AgentBuildStateSchema = z.object({
  status: z.enum([
    'queued',
    'generating',
    'parsed',
    'fixing',
    'retrying',
    'validated',
    'compiled',
    'warning',
    'error',
    'interrupted',
  ]),
  stages: z.object({
    gen: AgentBuildStageSchema,
    comp: AgentBuildStageSchema,
    enrich: AgentBuildStageSchema,
    done: AgentBuildStageSchema,
  }),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  toolCount: z.number().int().nonnegative().optional(),
  handoffCount: z.number().int().nonnegative().optional(),
  fixRounds: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    })
    .optional(),
  /** Five binary quality pills surfaced in the BuildProgressCard. */
  quality: z
    .object({
      guardrails: z.boolean(),
      memory: z.boolean(),
      errorHandlers: z.boolean(),
      constraints: z.boolean(),
      catchAllHandoff: z.boolean(),
    })
    .optional(),
  enrichment: z.object({ injected: z.array(z.string()) }).optional(),
  diagnostics: z
    .object({
      overallSeverity: z.enum(['error', 'warning', 'info']),
      summary: z.object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        infos: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }),
      findings: z
        .array(
          z.object({
            severity: z.string(),
            message: z.string(),
            line: z.number().int().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type AgentBuildState = z.infer<typeof AgentBuildStateSchema>;

export const BuildStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  compiled: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  retries: z.object({ agents: z.array(z.string()) }).optional(),
});
export type BuildStats = z.infer<typeof BuildStatsSchema>;

export const SpecPatchSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
  op: z.enum(['set', 'delete']).optional(),
});
export type SpecPatch = z.infer<typeof SpecPatchSchema>;

export const PlanArtifactStatusSchema = z.enum([
  'proposed',
  'approved',
  'refining',
  'cancelled',
  'invalidated',
  'authoring',
  'superseded',
]);
export type PlanArtifactStatus = z.infer<typeof PlanArtifactStatusSchema>;

export const PlanArtifactPayloadSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).optional(),
  status: PlanArtifactStatusSchema,
  title: z.string().min(1),
  goal: z.string().min(1),
  summary: z.string().min(1),
  affectedAgents: z.array(z.string()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type PlanArtifactPayload = z.infer<typeof PlanArtifactPayloadSchema>;

export const CompletionMetadataSchema = z.object({
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().optional(),
  }),
  finishReason: z.string(),
  stepCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string(),
  estimatedUsd: z.number().nonnegative().optional(),
});
export type CompletionMetadata = z.infer<typeof CompletionMetadataSchema>;

export const ArchSuggestionSchema = z.object({
  text: z.string().min(1),
  icon: z.string().optional(),
  category: z.string().optional(),
});
export type ArchSuggestion = z.infer<typeof ArchSuggestionSchema>;

// ─── ArtifactUpdate (13 variants) ────────────────────────────────────────

/**
 * Rich union for every artifact-panel state change. Each variant's `payload` is
 * externally-typed (see module docstring).
 *
 * Uses `z.union` rather than `z.discriminatedUnion` because two variants share
 * the `artifact: 'build'` discriminator value (nested scope discriminator). The
 * TS type is still a discriminated union on both `artifact` and (for 'build') `scope`.
 */
export const ArtifactUpdateSchema = z.union([
  z.object({ artifact: z.literal('topology'), payload: z.unknown() }),
  z.object({
    artifact: z.literal('spec'),
    version: z.number().int().nonnegative(),
    patches: z.array(SpecPatchSchema),
  }),
  z.object({ artifact: z.literal('journal'), entry: z.unknown() }),
  z.object({
    artifact: z.literal('build'),
    scope: z.literal('agent'),
    agent: z.string().min(1),
    state: AgentBuildStateSchema,
  }),
  z.object({
    artifact: z.literal('build'),
    scope: z.literal('overall'),
    stats: BuildStatsSchema,
    phase: z.enum(['generating', 'agents_complete', 'complete']).optional(),
  }),
  z.object({
    artifact: z.literal('file'),
    agent: z.string().min(1),
    action: z.enum(['start', 'delta', 'end', 'delete']),
    fileKind: z.enum(['agent', 'mock', 'tool']),
    path: z.string().optional(),
    content: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.object({
    artifact: z.literal('diff'),
    diffId: z.string().min(1),
    status: z.enum(['pending', 'applying', 'applied', 'rejected']),
    payload: z.unknown().optional(),
  }),
  z.object({
    artifact: z.literal('plan'),
    planId: z.string().min(1),
    status: PlanArtifactStatusSchema,
    payload: PlanArtifactPayloadSchema,
  }),
  z.object({
    artifact: z.literal('widget'),
    variant: z.enum([
      'model_comparison',
      'constraint_coverage',
      'kb_status_card',
      'upload_progress_card',
      'search_results_card',
      'kb_health_card',
      'connector_status_card',
      'doc_processing_card',
      'integration_suggestion_card',
      'external_agent_card',
      'traces',
      'diagnostics',
      'health',
      'insights',
    ]),
    payload: z.unknown(),
  }),
  z.object({
    artifact: z.literal('project'),
    payload: z.object({
      projectId: z.string().min(1),
      name: z.string(),
      stats: z.unknown().optional(),
    }),
  }),
  z.object({ artifact: z.literal('health'), payload: z.unknown() }),
  z.object({ artifact: z.literal('traces'), payload: z.unknown() }),
  z.object({ artifact: z.literal('diagnostics'), payload: z.unknown() }),
  z.object({ artifact: z.literal('insights'), payload: z.unknown() }),
]);
export type ArtifactUpdate = z.infer<typeof ArtifactUpdateSchema>;

// ─── TurnEndReason ───────────────────────────────────────────────────────

export const TurnEndReasonSchema = z.enum([
  'natural',
  'interrupted',
  'canceled',
  'error',
  'tool_limit_exceeded',
  'token_budget_exhausted',
  'cost_budget_exhausted',
  'session_cost_exhausted',
  'loop_detected',
  'turn_soft_timeout',
  'model_provider_error',
  'model_timeout',
  'model_auth_error',
  'model_context_length',
  'worker_lost',
]);
export type TurnEndReason = z.infer<typeof TurnEndReasonSchema>;

// ─── TurnEvent (8 variants) ──────────────────────────────────────────────

const turnStartedBodySchema = z.object({
  type: z.literal('turn_started'),
  specialist: z.string().optional(),
  userMessageId: z.string().min(1),
});

const textDeltaBodySchema = z.object({
  type: z.literal('text_delta'),
  delta: z.string(),
  specialist: z.string().optional(),
});

const statusBodySchema = z.object({
  type: z.literal('status'),
  label: z.string(),
  progress: z
    .object({
      step: z.number().int().nonnegative(),
      total: z.number().int().positive(),
    })
    .optional(),
  activity: ActivityStepSchema.optional(),
});

const artifactUpdatedBodySchema = z.object({
  type: z.literal('artifact_updated'),
  update: ArtifactUpdateSchema,
});

const planLifecycleBaseSchema = z.object({
  planId: z.string().min(1),
  payload: PlanArtifactPayloadSchema,
});

const planProposedBodySchema = planLifecycleBaseSchema.extend({
  type: z.literal('plan_proposed'),
  status: z.literal('proposed'),
});

const planApprovedBodySchema = planLifecycleBaseSchema.extend({
  type: z.literal('plan_approved'),
  status: z.literal('approved'),
});

const planRefiningBodySchema = planLifecycleBaseSchema.extend({
  type: z.literal('plan_refining'),
  status: z.literal('refining'),
});

const planCancelledBodySchema = planLifecycleBaseSchema.extend({
  type: z.literal('plan_cancelled'),
  status: z.literal('cancelled'),
});

const planInvalidatedBodySchema = planLifecycleBaseSchema.extend({
  type: z.literal('plan_invalidated'),
  status: z.literal('invalidated'),
});

const turnCommittedBodySchema = z.object({
  type: z.literal('turn_committed'),
  /** Current phase post-commit. In IN_PROJECT mode always 'IN_PROJECT'. */
  phase: z.string().min(1),
  /** If true, client auto-continues with a follow-up turn (used at phase boundaries). */
  autoContinue: z.boolean().optional(),
  /** Signals a post-commit override action requested by the LLM (e.g., retry BUILD). */
  qualityGateOverride: z
    .object({
      action: z.enum(['retry_create', 'retry_failed', 'proceed_anyway']),
    })
    .optional(),
});

const interactiveToolBodySchema = z.object({
  type: z.literal('interactive_tool'),
  tool: z.string().min(1),
  toolCallId: z.string().min(1),
  kind: z.enum(['tool', 'gate']),
  /**
   * For kind:'tool', payload equals the LLM tool-call input (widget descriptor).
   * For kind:'gate', payload includes {gateType, data, gateId}.
   */
  payload: z.unknown(),
});

const turnEndedBodySchema = z.object({
  type: z.literal('turn_ended'),
  reason: TurnEndReasonSchema,
  completion: CompletionMetadataSchema.optional(),
  suggestions: z.array(ArchSuggestionSchema).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .optional(),
});

const errorBodySchema = z.object({
  type: z.literal('error'),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional(),
    requestId: z.string().optional(),
  }),
});

const phaseTransitionBodySchema = z.object({
  type: z.literal('phase_transition'),
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
});

/**
 * The 9 TurnEvent variants. Each embeds the envelope at the top level for
 * simplicity over nested {envelope, body} shapes — matches how SSE frames
 * serialize in practice.
 */
export const TurnEventSchema = z.discriminatedUnion('type', [
  EnvelopeSchema.extend(turnStartedBodySchema.shape),
  EnvelopeSchema.extend(textDeltaBodySchema.shape),
  EnvelopeSchema.extend(statusBodySchema.shape),
  EnvelopeSchema.extend(artifactUpdatedBodySchema.shape),
  EnvelopeSchema.extend(planProposedBodySchema.shape),
  EnvelopeSchema.extend(planApprovedBodySchema.shape),
  EnvelopeSchema.extend(planRefiningBodySchema.shape),
  EnvelopeSchema.extend(planCancelledBodySchema.shape),
  EnvelopeSchema.extend(planInvalidatedBodySchema.shape),
  EnvelopeSchema.extend(turnCommittedBodySchema.shape),
  EnvelopeSchema.extend(interactiveToolBodySchema.shape),
  EnvelopeSchema.extend(turnEndedBodySchema.shape),
  EnvelopeSchema.extend(errorBodySchema.shape),
  EnvelopeSchema.extend(phaseTransitionBodySchema.shape),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

// Individual variant types for narrow handlers.
export type TurnStartedEvent = Envelope & z.infer<typeof turnStartedBodySchema>;
export type TextDeltaEvent = Envelope & z.infer<typeof textDeltaBodySchema>;
export type StatusEvent = Envelope & z.infer<typeof statusBodySchema>;
export type ArtifactUpdatedEvent = Envelope & z.infer<typeof artifactUpdatedBodySchema>;
export type PlanLifecycleEvent = Envelope &
  (
    | z.infer<typeof planProposedBodySchema>
    | z.infer<typeof planApprovedBodySchema>
    | z.infer<typeof planRefiningBodySchema>
    | z.infer<typeof planCancelledBodySchema>
    | z.infer<typeof planInvalidatedBodySchema>
  );
export type TurnCommittedEvent = Envelope & z.infer<typeof turnCommittedBodySchema>;
export type InteractiveToolEvent = Envelope & z.infer<typeof interactiveToolBodySchema>;
export type TurnEndedEvent = Envelope & z.infer<typeof turnEndedBodySchema>;
export type ErrorEvent = Envelope & z.infer<typeof errorBodySchema>;
export type PhaseTransitionEvent = Envelope & z.infer<typeof phaseTransitionBodySchema>;

// ─── SessionSignal (non-TurnEvent envelope on the fan-out channel) ───────

/**
 * Out-of-band signals published on the same Redis fan-out channel as TurnEvents.
 * Used for session-level state changes that are NOT part of a turn (currently only
 * queue updates). Discriminated from TurnEvent via the `kind` field.
 *
 * Per design decision D-20: kept separate from the TurnEvent union so the
 * 8-event schema promise stays honest and turn-boundary semantics remain clean.
 */
export const SessionSignalSchema = EnvelopeSchema.extend({
  kind: z.literal('session_signal'),
  signal: z.enum(['queue_updated', 'queue_cleared']),
  queuedPreview: z.string().optional(),
});
export type SessionSignal = z.infer<typeof SessionSignalSchema>;

/**
 * Anything that can arrive on the fan-out channel. Clients discriminate
 * on the `kind` field (present on SessionSignal, absent on TurnEvent).
 */
export const FanOutEnvelopeSchema = z.union([TurnEventSchema, SessionSignalSchema]);
export type FanOutEnvelope = z.infer<typeof FanOutEnvelopeSchema>;
