/**
 * Supervisor ABL types
 */

import type { DocumentMeta, ElementId, TypeDefinition, VariableDefinition } from './base.js';
import type { Condition, Expression } from './expressions.js';

/**
 * State schema definition for supervisor
 */
export interface StateSchema {
  [namespace: string]: {
    [variable: string]: VariableDefinition;
  };
}

/**
 * Agent reference in supervisor
 */
export interface AgentRef {
  ref: string; // Path to agent ABL file
  alias: string; // Local name for the agent
  capabilities: string[];
  channels?: string[];
  requiresValidation?: boolean;
}

/**
 * Route to a specific agent
 */
export interface RouteToAgent {
  kind: 'route_to_agent';
  agent: string;
  setActive?: boolean;
  silent?: boolean;
}

/**
 * Route to user (wait for input)
 */
export interface RouteToUser {
  kind: 'route_to_user';
  message?: string;
}

/**
 * Route based on a variable value
 */
export interface RouteToVariable {
  kind: 'route_to_variable';
  variable: string;
}

/**
 * Agent handoff action
 */
export interface AgentHandoff {
  kind: 'agent_handoff';
  params: Record<string, Expression>;
}

/**
 * End conversation action
 */
export interface EndConversation {
  kind: 'end_conversation';
}

/**
 * Intent-based routing action
 */
export interface IntentMatchRouting {
  kind: 'intent_match';
  mappings: IntentMapping[];
  fallback?: RoutingAction;
}

/**
 * System action (like handoff)
 */
export interface SystemAction {
  kind: 'system_action';
  action: string;
  params?: Record<string, Expression>;
}

/**
 * Routing action types
 */
export type RoutingAction =
  | RouteToAgent
  | RouteToUser
  | RouteToVariable
  | AgentHandoff
  | EndConversation
  | IntentMatchRouting
  | SystemAction;

/**
 * Intent to agent mapping
 */
export interface IntentMapping {
  intents: string[];
  action: RoutingAction;
}

/**
 * Routing rule flags
 */
export type RoutingFlag = 'set_active' | 'silent' | 'no_log' | 'priority_boost';

/**
 * Single routing rule
 */
export interface RoutingRule {
  id: ElementId;
  name: string;
  description?: string;
  priority: number;
  when: Condition;
  then: RoutingAction;
  flags?: RoutingFlag[];
  constraints?: {
    ignoreIntents?: string[];
    channels?: string[];
    requiresState?: string[];
  };
}

/**
 * Policy definition
 */
export interface Policy {
  name: string;
  description?: string;
  rules: {
    allowedWhen?: Condition;
    forbiddenWhen?: Condition;
    triggerSignal?: string;
    behavior?: string;
  };
}

/**
 * Communication formality level
 */
export type Formality = 'formal' | 'informal' | 'neutral';

/**
 * Pronoun settings
 */
export interface PronounSettings {
  use: string;
  avoid: string;
}

/**
 * Vocabulary preferences
 */
export interface VocabularySettings {
  prefer: string[];
  avoid: string[];
}

/**
 * Communication settings
 */
export interface CommunicationSettings {
  language: string;
  formality: Formality;
  pronouns?: PronounSettings;
  vocabulary?: VocabularySettings;
  constraints: string[];
}

/**
 * Supervisor behavior settings
 */
export interface SupervisorBehavior {
  canRespondDirectly: boolean;
  allowedDirectActions: string[];
  forbiddenActions: string[];
}

/**
 * Complete Supervisor ABL document
 */
export interface SupervisorDocument {
  meta: DocumentMeta;
  state: StateSchema;
  agents: AgentRef[];
  routing: RoutingRule[];
  intents?: IntentMapping[];
  policies: Policy[];
  communication: CommunicationSettings;
  behavior: SupervisorBehavior;
}

/**
 * Create a new empty supervisor document
 */
export function createSupervisorDocument(
  name: string,
  options: Partial<SupervisorDocument> = {},
): SupervisorDocument {
  const now = new Date();
  return {
    meta: {
      id: crypto.randomUUID(),
      kind: 'supervisor',
      version: '1.0.0',
      name,
      createdAt: now,
      updatedAt: now,
    },
    state: options.state ?? {},
    agents: options.agents ?? [],
    routing: options.routing ?? [],
    intents: options.intents,
    policies: options.policies ?? [],
    communication: options.communication ?? {
      language: 'en',
      formality: 'neutral',
      constraints: [],
    },
    behavior: options.behavior ?? {
      canRespondDirectly: false,
      allowedDirectActions: [],
      forbiddenActions: [],
    },
  };
}

/**
 * Create a routing rule
 */
export function createRoutingRule(
  priority: number,
  when: Condition,
  then: RoutingAction,
  options: Partial<Omit<RoutingRule, 'priority' | 'when' | 'then'>> = {},
): RoutingRule {
  return {
    id: options.id ?? crypto.randomUUID(),
    name: options.name ?? `Rule_${priority}`,
    description: options.description,
    priority,
    when,
    then,
    flags: options.flags,
    constraints: options.constraints,
  };
}

/**
 * Helper to route to an agent
 */
export function routeToAgent(
  agent: string,
  options: { setActive?: boolean; silent?: boolean } = {},
): RouteToAgent {
  return {
    kind: 'route_to_agent',
    agent,
    setActive: options.setActive,
    silent: options.silent,
  };
}

/**
 * Helper to create intent match routing
 */
export function intentMatch(
  mappings: IntentMapping[],
  fallback?: RoutingAction,
): IntentMatchRouting {
  return {
    kind: 'intent_match',
    mappings,
    fallback,
  };
}
