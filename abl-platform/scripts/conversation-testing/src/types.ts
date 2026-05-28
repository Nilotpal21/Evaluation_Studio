/**
 * Core types for the conversation-testing package.
 */

/** Names of the built-in behavioral presets. `auto` mixes all profiles across a single run. */
export type PresetName =
  | 'auto'
  | 'balanced'
  | 'stress-negative'
  | 'short-simple'
  | 'long-complex'
  | 'abandonment';

/** A single generated scenario describing one simulated conversation. */
export interface Scenario {
  /** The inferred intent this scenario exercises (e.g. "billing_dispute"). */
  intent: string;
  /** Short persona description (e.g. "Frustrated small-business owner"). */
  persona: string;
  /** What the persona wants to achieve in the conversation. */
  goal: string;
  /** How the persona behaves (tone, verbosity, mood). */
  behavior: string;
  /** When the persona should end the conversation. */
  endCondition: string;
  /** The target agent this scenario aims to route to (only set in all-agents mode). */
  targetAgent?: string;
  /** The behavioral preset randomly assigned to this scenario (only set when PRESET=auto). */
  assignedPreset?: PresetName;
}

/** Pre-computed per-scenario assignment (used when PRESET=auto). */
export interface SlotAssignment {
  preset: Exclude<PresetName, 'auto'>;
  targetAgent?: string;
}

/** Summary of an agent in the bot topology (used in all-agents mode). */
export interface AgentSummary {
  name: string;
  goal: string;
  description: string;
}

/** A single message in a transcript. */
export interface TranscriptMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
}

/** The outcome of a single conversation run. */
export type TranscriptOutcome = 'success' | 'failed' | 'timeout' | 'max_turns';

/** Full transcript of a single conversation. */
export interface Transcript {
  scenarioIndex: number;
  scenario: Scenario;
  messages: TranscriptMessage[];
  startedAt: string;
  endedAt: string;
  outcome: TranscriptOutcome;
  error?: string;
}

/** Provider-agnostic message shape for LLM calls. */
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Interface for an LLM client. */
export interface LLMClient {
  chat(messages: LLMMessage[], system?: string): Promise<string>;
}

/** Domain context discovered from the bot. */
export interface DomainContext {
  projectName: string;
  welcomeMessage: string;
  hint?: string;
}

/** Configuration for a scenario-generation + conversation run. */
export interface RunConfig {
  runs: number;
  preset: PresetName;
  instructions?: string;
  domain: DomainContext;
  /** When set, generator produces `runsPerAgent` scenarios per agent, one targeted at each. */
  agents?: AgentSummary[];
  /** Scenarios per agent (only used when `agents` is set). Defaults to 3. */
  runsPerAgent?: number;
}

/** Builds WebSocket subprotocols for SDK authentication. Injected so tests do not need to mock platform modules. */
export type ProtocolBuilder = (sdkToken: string) => string[];

/** Options passed to the conversation runner. */
export interface ConversationRunnerOpts {
  scenarioIndex: number;
  runtimeWsUrl?: string;
  maxTurns?: number;
  timeoutMs?: number;
  debugPrompts?: boolean;
  /** Override the SDK WS protocol builder. Defaults to `buildSdkWSProtocols` from shared-auth. */
  protocolBuilder?: ProtocolBuilder;
}
