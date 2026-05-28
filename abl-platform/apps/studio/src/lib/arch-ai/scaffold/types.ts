/**
 * Shared types for the scaffold+fill pipeline.
 *
 * - AblSkeleton: structured IR produced by scaffold-generator, contains all
 *   deterministic fields (keyword, HANDOFFs with real TO: names, RETURN
 *   flags, MEMORY/GUARDRAILS shells) plus slot placeholders for creative
 *   fields.
 * - CreativeContent: validated string-valued JSON from the LLM, flattened
 *   into dotted slot paths.
 * - SlotMap: runtime line-range lookup for mapping compile errors back to
 *   slots.
 *
 * See docs/superpowers/specs/2026-04-17-arch-ai-build-scaffold-fill-design.md.
 */

import type { z } from 'zod';
import type { AgentArchitecturePlan } from '@agent-platform/arch-ai/planning/types';
import type { TopologyOutput } from '@agent-platform/arch-ai/types';

// ─── Skeleton (structural, code-owned) ─────────────────────────────────────

export interface HandoffEntry {
  to: string;
  returnExpected: boolean;
  experienceMode?:
    | 'shared_voice_handoff'
    | 'visible_handoff'
    | 'silent_delegate'
    | 'human_escalation';
  /**
   * Slot path for the WHEN clause, e.g. "handoff.0.when". Null for catch-all
   * (the WHEN is the literal "true").
   */
  whenSlot: string | null;
  /** If whenSlot is null, this is the literal WHEN value (catch-all uses "true"). */
  whenLiteral?: string;
}

export interface GatherField {
  name: string;
  type: string;
  source?: 'user' | 'context' | 'tool' | 'memory';
  /** Slot path for the ask prompt. */
  askSlot: string;
}

export interface ToolStub {
  name: string;
  signatureLiteral: string;
  descriptionLiteral: string;
  sideEffects: boolean;
  confirmPolicy: 'never' | 'when_side_effects';
  inputFieldsAreContractDriven?: boolean;
  /** Per-parameter descriptions emitted as ABL params metadata. */
  paramDescriptions: Record<string, string>;
  signatureSlot: string;
  descriptionSlot: string;
}

export interface CompleteSlotPair {
  /** Slot path for the WHEN clause, or null when the condition is code-owned. */
  whenSlot: string | null;
  /** Slot path for the RESPOND clause, or null when the response is code-owned. */
  respondSlot: string | null;
  /** If whenSlot is null, this is the literal WHEN expression emitted into YAML. */
  whenLiteral?: string;
  /** If respondSlot is null, this is the literal RESPOND emitted into YAML. */
  respondLiteral?: string;
}

export type AgentRuntimePattern =
  | 'router'
  | 'tool_worker'
  | 'transaction'
  | 'escalation'
  | 'pipeline_stage'
  | 'returnable_child'
  | 'intake'
  | 'reasoning';

export interface AblSkeleton {
  agentName: string;
  keyword: 'AGENT' | 'SUPERVISOR';
  /**
   * Code-owned runtime intent for deterministic FLOW/CALL rendering. This is
   * intentionally coarser than executionMode; it captures how the agent should
   * behave at runtime without letting the LLM invent unsupported constructs.
   */
  runtimePattern: AgentRuntimePattern;
  /** Slot path for GOAL text. Always present. */
  goalSlot: string;
  /** Slot path for PERSONA text. Always present. */
  personaSlot: string;
  /** Code-owned welcome response for the topology entry agent. */
  onStartRespond?: string;
  /** Behavior profiles the assembled agent should reference. */
  behaviorProfileUses?: string[];
  /** Ordered HANDOFF entries including catch-all (last). Empty for sink agents. */
  handoffs: HandoffEntry[];
  /** GATHER fields when the plan requires them, empty otherwise. */
  gatherFields: GatherField[];
  /** COMPLETE conditions. Some may be code-owned literals instead of LLM-filled slots. */
  completeSlots: CompleteSlotPair[];
  /** MEMORY.session variable names — typically derived from gatherFields. */
  memorySessionVars: string[];
  /** Tool stubs (reserved for future slice). */
  tools: ToolStub[];
  /** Whether GUARDRAILS.content_safety shell is included. */
  includeGuardrails: boolean;
}

// ─── Creative content (LLM-owned, schema-validated) ────────────────────────

/**
 * Validated JSON-like content from the LLM, flattened into dotted slot paths.
 * Every key corresponds to a slot path emitted by the scaffold generator.
 */
export type CreativeContent = Record<string, string>;

// ─── Slot map (runtime artifact) ───────────────────────────────────────────

/** Line range (1-indexed, inclusive) for a slot's contribution to the YAML. */
export interface SlotLineRange {
  lineStart: number;
  lineEnd: number;
}

/** Map from slot path to its line range in the assembled YAML. */
export type SlotMap = Map<string, SlotLineRange>;

// ─── Scaffold result ───────────────────────────────────────────────────────

/**
 * The Zod schema the LLM must match. We type it loosely (`z.ZodTypeAny`) so
 * each archetype's builder can return its own concrete shape without forcing
 * a common generic.
 */
export type CreativeSchema = z.ZodTypeAny;

export interface ScaffoldResult {
  skeleton: AblSkeleton;
  /** Zod schema passed to AI SDK's generateObject for structured output. */
  creativeSchema: CreativeSchema;
  /**
   * Rendered system prompt describing agent context (name, role, domain,
   * topology hints). Does NOT contain structural data the scaffold owns —
   * the LLM cannot modify HANDOFF TO: names or keywords.
   */
  prompt: string;
}

// ─── Fill loop result ──────────────────────────────────────────────────────

export interface FillLoopResult {
  /** Assembled ABL YAML, ready to persist. */
  yaml: string;
  /** Slot map from the successful assembly. */
  slotMap: SlotMap;
  /** Validated creative content that produced this YAML. */
  creative: CreativeContent;
  /** Per-slot attempt counts. Zero-retry slots have count 1. */
  slotAttempts: Record<string, number>;
  /** Slots that fell back to defaults (tracked as warnings). */
  fallbackSlots: string[];
  /** Final compiler status after assembly. */
  compileStatus: 'pass' | 'warning' | 'error';
  compileErrors: string[];
  compileWarnings: string[];
}

// ─── Inputs from the existing planner / session ────────────────────────────

export type { AgentArchitecturePlan, TopologyOutput };

/** Agent spec the worker receives from the BLUEPRINT phase. */
export interface AgentSpecInput {
  name: string;
  role: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  gatherFieldSources?: Record<string, 'user' | 'context' | 'tool' | 'memory'>;
  isEntry: boolean;
}

/** Domain context from the session's blueprint. */
export interface DomainContextInput {
  domain: string;
  channels: string[];
  language?: string;
  compliance: string[];
  integrations: string[];
  tone: string;
  blueprintSummary?: string;
  universalRules?: string[];
  channelRules?: Array<{
    channel: string;
    responseMaxWords?: number;
    abbreviationPolicy?: 'expand_for_voice' | 'preserve_text';
    toolLatencyBridge?: boolean;
    rules?: string[];
  }>;
  sourceToolFixtures?: Array<{
    toolName: string;
    sampleInput?: Record<string, unknown>;
    response: unknown;
  }>;
  sharedMemoryVariables?: string[];
  sourceTools?: Array<{
    name: string;
    signature?: string;
    description?: string;
    callWhen?: string[];
    doNotCallWhen?: string[];
  }>;
  consentPolicies?: Array<{
    toolName?: string;
    action: string;
    mode: 'never' | 'always' | 'when_side_effects';
    requiredIn: 'conversation' | 'explicit_prompt';
    scopeFields: string[];
    fallback: 'explicit_prompt' | 'block';
  }>;
}
