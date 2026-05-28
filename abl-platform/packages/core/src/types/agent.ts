/**
 * Agent ABL types
 */

import type { DocumentMeta, ElementId, TypeDefinition } from './base.js';
import type { Condition, Expression } from './expressions.js';
import type { CommunicationSettings } from './supervisor.js';

/**
 * Agent identity and persona
 */
export interface AgentIdentity {
  role: string;
  persona: string;
  expertise: string[];
  limitations: string[];
}

/**
 * Agent input/output contract
 */
export interface AgentContract {
  inputs: {
    required: Record<string, TypeDefinition>;
    optional: Record<string, TypeDefinition>;
  };
  outputs: {
    response: TypeDefinition;
    stateUpdates?: TypeDefinition;
    signal: { kind: 'enum'; values: string[] };
    handoffMetadata?: TypeDefinition;
  };
}

/**
 * Tool parameter definition
 */
export interface ToolParameter {
  name: string;
  type: TypeDefinition;
  required: boolean;
  default?: unknown;
  description?: string;
}

/**
 * Tool failure handling strategy
 */
export type FailureStrategy = 'retry' | 'escalate' | 'fallback';

/**
 * Tool error handling configuration
 */
export interface ToolErrorHandling {
  onFailure: FailureStrategy;
  maxRetries?: number;
  fallbackAction?: string;
}

/**
 * Tool definition
 */
export interface ToolDefinition {
  id: ElementId;
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: TypeDefinition;
  errorHandling?: ToolErrorHandling;
  sideEffects?: string[];
  cacheable?: boolean;
  cacheTtl?: number;
}

/**
 * Call tool action
 */
export interface CallToolAction {
  kind: 'call_tool';
  tool: string;
  params: Record<string, Expression>;
  onSuccess?: string;
  onFailure?: string;
}

/**
 * Respond action
 */
export interface RespondAction {
  kind: 'respond';
  message: Expression;
}

/**
 * Wait for user input action
 */
export interface WaitInputAction {
  kind: 'wait_input';
  routes: Record<string, string>; // input type -> step name
  maxAttempts?: number;
  onMaxExceeded?: string;
}

/**
 * Goto action
 */
export interface GotoAction {
  kind: 'goto';
  target: string;
}

/**
 * Conditional action
 */
export interface ConditionAction {
  kind: 'condition';
  when: Condition;
  then: StepAction;
  else?: StepAction;
}

/**
 * Signal types
 */
export type SignalType = 'CONTINUE' | 'COMPLETE' | 'HANDOFF_READY' | 'ESCALATE' | 'ERROR';

/**
 * Signal action
 */
export interface SignalAction {
  kind: 'signal';
  signal: SignalType | string;
  message?: Expression;
}

/**
 * Set state action
 */
export interface SetStateAction {
  kind: 'set_state';
  updates: Record<string, Expression>;
}

/**
 * Classify intent action
 */
export interface ClassifyIntentAction {
  kind: 'classify_intent';
  intents: Record<string, string>; // intent -> step name
  default?: string;
}

/**
 * Multi-step action (sequential execution)
 */
export interface MultiStepAction {
  kind: 'multi_step';
  steps: StepAction[];
}

/**
 * Step action types
 */
export type StepAction =
  | CallToolAction
  | RespondAction
  | WaitInputAction
  | GotoAction
  | ConditionAction
  | SignalAction
  | SetStateAction
  | ClassifyIntentAction
  | MultiStepAction;

/**
 * Step definition
 */
export interface Step {
  id: ElementId;
  number: number;
  name: string;
  description?: string;
  action: StepAction;
  guards?: Condition[];
  timeout?: number;
  retries?: number;
}

/**
 * Flow definition (collection of steps)
 */
export interface Flow {
  entryPoint: string;
  steps: Step[];
}

/**
 * Guardrail type
 */
export type GuardrailType = 'input' | 'output' | 'behavioral';

/**
 * Guardrail action
 */
export type GuardrailAction = 'block' | 'warn' | 'redact' | 'transform';

/**
 * Guardrail definition
 */
export interface Guardrail {
  name: string;
  description?: string;
  type: GuardrailType;
  check: Condition | string; // Condition or named check
  action: GuardrailAction;
  message?: string;
}

/**
 * Knowledge source settings
 */
export interface KnowledgeSettings {
  sources: string[];
  strategy: 'rag' | 'function' | 'hybrid';
  maxResults?: number;
}

/**
 * Reasoning strategy
 */
export type ReasoningStrategy = 'react' | 'cot' | 'direct';

/**
 * Reasoning configuration
 */
export interface ReasoningConfig {
  strategy: ReasoningStrategy;
  planning: boolean;
  maxSteps: number;
}

/**
 * Test case definition
 */
export interface TestCase {
  name: string;
  input: string;
  expected: {
    toolCalled?: string;
    responseContains?: string;
    signal?: string;
    stateUpdates?: Record<string, unknown>;
  };
}

/**
 * Complete Agent ABL document
 */
export interface AgentDocument {
  meta: DocumentMeta;
  identity: AgentIdentity;
  contract: AgentContract;
  tools: ToolDefinition[];
  knowledge?: KnowledgeSettings;
  reasoning?: ReasoningConfig;
  flow: Flow;
  guardrails: Guardrail[];
  communication?: Partial<CommunicationSettings>;
  tests?: TestCase[];
}

/**
 * Create a new empty agent document
 */
export function createAgentDocument(
  name: string,
  role: string,
  options: Partial<AgentDocument> = {},
): AgentDocument {
  const now = new Date();
  return {
    meta: {
      id: crypto.randomUUID(),
      kind: 'agent',
      version: '1.0.0',
      name,
      createdAt: now,
      updatedAt: now,
    },
    identity: options.identity ?? {
      role,
      persona: '',
      expertise: [],
      limitations: [],
    },
    contract: options.contract ?? {
      inputs: { required: {}, optional: {} },
      outputs: {
        response: 'string',
        signal: { kind: 'enum', values: ['CONTINUE', 'COMPLETE', 'HANDOFF_READY', 'ESCALATE'] },
      },
    },
    tools: options.tools ?? [],
    knowledge: options.knowledge,
    reasoning: options.reasoning,
    flow: options.flow ?? {
      entryPoint: 'START',
      steps: [],
    },
    guardrails: options.guardrails ?? [],
    communication: options.communication,
    tests: options.tests,
  };
}

/**
 * Create a step
 */
export function createStep(
  number: number,
  name: string,
  action: StepAction,
  options: Partial<Omit<Step, 'number' | 'name' | 'action'>> = {},
): Step {
  return {
    id: options.id ?? crypto.randomUUID(),
    number,
    name,
    description: options.description,
    action,
    guards: options.guards,
    timeout: options.timeout,
    retries: options.retries,
  };
}

/**
 * Create a respond action
 */
export function respond(message: Expression | string): RespondAction {
  return {
    kind: 'respond',
    message: typeof message === 'string' ? { kind: 'string', value: message } : message,
  };
}

/**
 * Create a call tool action
 */
export function callTool(
  tool: string,
  params: Record<string, Expression> = {},
  options: { onSuccess?: string; onFailure?: string } = {},
): CallToolAction {
  return {
    kind: 'call_tool',
    tool,
    params,
    onSuccess: options.onSuccess,
    onFailure: options.onFailure,
  };
}

/**
 * Create a signal action
 */
export function signal(sig: SignalType | string, message?: Expression | string): SignalAction {
  return {
    kind: 'signal',
    signal: sig,
    message: message
      ? typeof message === 'string'
        ? { kind: 'string', value: message }
        : message
      : undefined,
  };
}

/**
 * Create a wait input action
 */
export function waitInput(
  routes: Record<string, string>,
  options: { maxAttempts?: number; onMaxExceeded?: string } = {},
): WaitInputAction {
  return {
    kind: 'wait_input',
    routes,
    maxAttempts: options.maxAttempts,
    onMaxExceeded: options.onMaxExceeded,
  };
}

/**
 * Create a goto action
 */
export function goto(target: string): GotoAction {
  return { kind: 'goto', target };
}

/**
 * Create a set state action
 */
export function setState(updates: Record<string, Expression>): SetStateAction {
  return { kind: 'set_state', updates };
}

/**
 * Create a classify intent action
 */
export function classify(
  intents: Record<string, string>,
  defaultStep?: string,
): ClassifyIntentAction {
  return {
    kind: 'classify_intent',
    intents,
    default: defaultStep,
  };
}
