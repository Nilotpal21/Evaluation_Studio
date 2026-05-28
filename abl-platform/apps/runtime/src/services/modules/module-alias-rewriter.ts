/**
 * Module Alias Rewriter
 *
 * Rewrites all internal agent/tool name references in a module's compiled IR
 * so they use the consumer's alias prefix. For example, if a module has agents
 * `main` and `helper`, and the consumer imports with alias `payments`, they
 * become `payments__main` and `payments__helper`.
 */

import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { ResolvedAgentIR, ResolvedToolDefinition } from './types.js';

const log = createLogger('module-alias-rewriter');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Double-underscore separator between alias and original name */
const SEPARATOR = '__';

/** Alias validation: lowercase, starts with letter, 2–25 chars, no double underscore */
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{1,24}$/;

/** Reserved prefixes that cannot be used as aliases */
const RESERVED_PREFIXES = ['system_', 'internal_', 'test_'];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AliasRewriteResult {
  agents: Record<string, ResolvedAgentIR>;
  tools: Record<string, ResolvedToolDefinition>;
  renameMap: Record<string, string>;
  collisions: string[];
}

// ---------------------------------------------------------------------------
// Alias validation
// ---------------------------------------------------------------------------

/**
 * Validates an alias string. Returns an error message if invalid, or null if valid.
 */
export function validateAlias(alias: string): string | null {
  if (!ALIAS_PATTERN.test(alias)) {
    return `Alias "${alias}" must match pattern ${ALIAS_PATTERN.source} (lowercase, 2-25 chars, starts with letter)`;
  }
  if (alias.includes(SEPARATOR)) {
    return `Alias "${alias}" must not contain double underscore "${SEPARATOR}"`;
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (alias.startsWith(prefix)) {
      return `Alias "${alias}" must not start with reserved prefix "${prefix}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rename map builder
// ---------------------------------------------------------------------------

/**
 * Builds a mapping from original names to alias-prefixed names.
 */
export function buildRenameMap(
  alias: string,
  agentNames: string[],
  toolNames: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of agentNames) {
    map[name] = `${alias}${SEPARATOR}${name}`;
  }
  for (const name of toolNames) {
    map[name] = `${alias}${SEPARATOR}${name}`;
  }
  return map;
}

function addAliasMapping(
  renameMap: Record<string, string>,
  sourceName: unknown,
  mountedName: string,
  conflicts: Set<string>,
): void {
  if (typeof sourceName !== 'string' || sourceName.length === 0) {
    return;
  }

  const existing = renameMap[sourceName];
  if (existing && existing !== mountedName) {
    conflicts.add(sourceName);
    return;
  }

  renameMap[sourceName] = mountedName;
}

function enrichRenameMapWithDeclaredNames(
  renameMap: Record<string, string>,
  agents: Record<string, AgentIR>,
  tools: Record<string, { definition: unknown; toolType: string }>,
): string[] {
  const conflicts = new Set<string>();

  for (const [artifactName, agentIR] of Object.entries(agents)) {
    const mountedName = renameMap[artifactName];
    if (!mountedName) {
      continue;
    }

    addAliasMapping(renameMap, agentIR.metadata?.name, mountedName, conflicts);
  }

  for (const [artifactName, toolEntry] of Object.entries(tools)) {
    const mountedName = renameMap[artifactName];
    if (!mountedName) {
      continue;
    }

    const definition = toolEntry.definition;
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
      addAliasMapping(renameMap, (definition as { name?: unknown }).name, mountedName, conflicts);
    }
  }

  return [...conflicts].sort();
}

function collectMountedNameCollisions(
  renameMap: Record<string, string>,
  agentNames: string[],
  toolNames: string[],
): string[] {
  const mountedSources = new Map<string, string>();
  const collisions: string[] = [];

  function visit(sourceName: string, sourceKind: 'agent' | 'tool'): void {
    const mountedName = renameMap[sourceName];
    if (!mountedName) {
      return;
    }

    const source = `${sourceKind}:${sourceName}`;
    const existingSource = mountedSources.get(mountedName);
    if (existingSource && existingSource !== source && !collisions.includes(mountedName)) {
      collisions.push(mountedName);
      return;
    }

    mountedSources.set(mountedName, source);
  }

  for (const agentName of agentNames) {
    visit(agentName, 'agent');
  }
  for (const toolName of toolNames) {
    visit(toolName, 'tool');
  }

  return collisions.sort();
}

// ---------------------------------------------------------------------------
// Deep IR rewrite helpers
// ---------------------------------------------------------------------------

/**
 * Rewrites a single string value if it exists in the rename map.
 */
function rewriteIfMapped(
  value: string | undefined,
  renameMap: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  return renameMap[value] ?? value;
}

/**
 * Rewrites an array of strings, replacing each entry that exists in the rename map.
 */
function rewriteStringArray(
  arr: string[] | undefined,
  renameMap: Record<string, string>,
): string[] | undefined {
  if (!arr) return undefined;
  return arr.map((v) => renameMap[v] ?? v);
}

function rewriteToolInvocation(
  container: Record<string, unknown>,
  renameMap: Record<string, string>,
): void {
  if (typeof container['call'] === 'string') {
    container['call'] = rewriteIfMapped(container['call'] as string, renameMap) as string;
  }

  if (container['call_spec'] && typeof container['call_spec'] === 'object') {
    const callSpec = container['call_spec'] as Record<string, unknown>;
    if (typeof callSpec['tool'] === 'string') {
      callSpec['tool'] = rewriteIfMapped(callSpec['tool'] as string, renameMap) as string;
    }
  }
}

/**
 * Rewrites agent name references within a flow step.
 * - call (tool name)
 * - on_start.call (tool name)
 * - on_start.delegate (agent name)
 *
 * Step names (step.name, step.then, on_input[].then, etc.) are NOT rewritten.
 * CEL condition strings (check, when) are NOT rewritten.
 */
function rewriteFlowStep(
  step: NonNullable<AgentIR['flow']>['definitions'][string],
  renameMap: Record<string, string>,
): void {
  const s = step as unknown as Record<string, unknown>;

  // Tool name in call
  rewriteToolInvocation(s, renameMap);

  // Reasoning zone available_tools
  if (s['reasoning_zone'] && typeof s['reasoning_zone'] === 'object') {
    const rz = s['reasoning_zone'] as Record<string, unknown>;
    if (Array.isArray(rz['available_tools'])) {
      rz['available_tools'] = rewriteStringArray(rz['available_tools'] as string[], renameMap);
    }
  }

  // on_success / on_failure — may have nested call or branches with call
  for (const blockKey of ['on_success', 'on_failure'] as const) {
    const block = s[blockKey];
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      rewriteToolInvocation(b, renameMap);
      if (Array.isArray(b['branches'])) {
        for (const branch of b['branches'] as Array<Record<string, unknown>>) {
          rewriteToolInvocation(branch, renameMap);
        }
      }
    }
  }

  // on_result branches
  if (Array.isArray(s['on_result'])) {
    for (const branch of s['on_result'] as Array<Record<string, unknown>>) {
      rewriteToolInvocation(branch, renameMap);
    }
  }

  // on_input branches
  if (Array.isArray(s['on_input'])) {
    for (const branch of s['on_input'] as Array<Record<string, unknown>>) {
      rewriteToolInvocation(branch, renameMap);
    }
  }

  // Digressions — delegate (agent name) and call (tool name)
  if (Array.isArray(s['digressions'])) {
    for (const d of s['digressions'] as Array<Record<string, unknown>>) {
      if (typeof d['delegate'] === 'string') {
        d['delegate'] = rewriteIfMapped(d['delegate'] as string, renameMap);
      }
      rewriteToolInvocation(d, renameMap);
      if (Array.isArray(d['do'])) {
        for (const action of d['do'] as Array<Record<string, unknown>>) {
          if (typeof action['delegate'] === 'string') {
            action['delegate'] = rewriteIfMapped(action['delegate'] as string, renameMap);
          }
          rewriteToolInvocation(action, renameMap);
        }
      }
    }
  }

  // Sub-intents — call (tool name)
  if (Array.isArray(s['sub_intents'])) {
    for (const si of s['sub_intents'] as Array<Record<string, unknown>>) {
      rewriteToolInvocation(si, renameMap);
    }
  }

  // on_action handlers — nested CALL actions and delegate/handoff targets
  if (Array.isArray(s['on_action'])) {
    for (const handler of s['on_action'] as Array<Record<string, unknown>>) {
      if (Array.isArray(handler['do'])) {
        for (const action of handler['do'] as Array<Record<string, unknown>>) {
          rewriteToolInvocation(action, renameMap);
          if (typeof action['handoff'] === 'string') {
            action['handoff'] = rewriteIfMapped(action['handoff'] as string, renameMap);
          }
          if (typeof action['delegate'] === 'string') {
            action['delegate'] = rewriteIfMapped(action['delegate'] as string, renameMap);
          }
        }
      }
    }
  }

  // on_error handlers — handoff_target (agent name)
  if (Array.isArray(s['on_error'])) {
    for (const handler of s['on_error'] as Array<Record<string, unknown>>) {
      if (typeof handler['handoff_target'] === 'string') {
        handler['handoff_target'] = rewriteIfMapped(handler['handoff_target'] as string, renameMap);
      }
    }
  }
}

/**
 * Rewrites agent/tool name references within a constraint's on_fail action
 * and checkpoint target.
 * - on_fail.target when type is 'handoff' (agent name)
 * - checkpoint.target when kind is 'tool_call' (tool name)
 */
function rewriteConstraint(
  constraint: {
    on_fail: { type: string; target?: string };
    checkpoint?: { kind: string; target?: string };
  },
  renameMap: Record<string, string>,
): void {
  if (constraint.on_fail.type === 'handoff' && typeof constraint.on_fail.target === 'string') {
    constraint.on_fail.target = rewriteIfMapped(constraint.on_fail.target, renameMap);
  }

  // Rewrite checkpoint.target for tool_call checkpoints (target is a tool name)
  if (
    constraint.checkpoint?.kind === 'tool_call' &&
    typeof constraint.checkpoint.target === 'string'
  ) {
    constraint.checkpoint.target = rewriteIfMapped(constraint.checkpoint.target, renameMap);
  }
}

/**
 * Deep-rewrites all agent and tool name references in a cloned AgentIR.
 * Mutates the provided IR object in place.
 */
function deepRewriteIR(ir: AgentIR, renameMap: Record<string, string>): void {
  // 1. metadata.name — rewrite agent identity FIRST
  ir.metadata.name = renameMap[ir.metadata.name] ?? ir.metadata.name;

  // 2. tools[].name — tool names
  if (ir.tools) {
    for (const tool of ir.tools) {
      tool.name = renameMap[tool.name] ?? tool.name;
    }
  }

  // 2b. Strip source-project variable_namespace_ids from tools
  if (ir.tools) {
    for (const tool of ir.tools) {
      const toolRecord = tool as unknown as Record<string, unknown>;
      if ('variable_namespace_ids' in toolRecord) {
        delete toolRecord.variable_namespace_ids;
      }
    }
  }

  // 3. coordination.handoffs[].to — handoff targets (agent names)
  if (ir.coordination?.handoffs) {
    for (const handoff of ir.coordination.handoffs) {
      handoff.to = renameMap[handoff.to] ?? handoff.to;
    }
  }

  // 4. coordination.delegates[].agent — delegate targets (agent names)
  if (ir.coordination?.delegates) {
    for (const delegate of ir.coordination.delegates) {
      delegate.agent = renameMap[delegate.agent] ?? delegate.agent;
    }
  }

  // 5. routing.rules[].to — routing targets (agent names)
  if (ir.routing?.rules) {
    for (const rule of ir.routing.rules) {
      rule.to = renameMap[rule.to] ?? rule.to;
    }
  }

  // 6. routing.default_agent — default routing target (agent name)
  if (ir.routing?.default_agent) {
    ir.routing.default_agent = renameMap[ir.routing.default_agent] ?? ir.routing.default_agent;
  }

  // 7. available_agents[] — agent names
  if (ir.available_agents) {
    ir.available_agents = ir.available_agents.map((name) => renameMap[name] ?? name);
  }

  // 8. constraints.constraints[].on_fail — handoff targets
  if (ir.constraints?.constraints) {
    for (const constraint of ir.constraints.constraints) {
      rewriteConstraint(constraint, renameMap);
    }
  }

  // 9. flow.definitions — tool names and agent names within flow steps
  if (ir.flow?.definitions) {
    for (const stepName of Object.keys(ir.flow.definitions)) {
      rewriteFlowStep(ir.flow.definitions[stepName], renameMap);
    }
  }

  // 10. flow.staticGraph — tool names in node step.call
  if (ir.flow?.staticGraph?.nodes) {
    for (const node of ir.flow.staticGraph.nodes) {
      if (node.step?.call) {
        node.step.call = rewriteIfMapped(node.step.call, renameMap) as string;
      }
    }
  }

  // 11. flow.global_digressions — delegate and call
  // (Note: human_approval fields onApprove/onReject/onTimeout are step names, not agent/tool names)
  if (ir.flow?.global_digressions) {
    for (const d of ir.flow.global_digressions) {
      if (d.delegate) {
        d.delegate = rewriteIfMapped(d.delegate, renameMap);
      }
      rewriteToolInvocation(d as unknown as Record<string, unknown>, renameMap);
      if (Array.isArray((d as unknown as Record<string, unknown>)['do'])) {
        for (const action of (d as unknown as Record<string, unknown>)['do'] as Array<
          Record<string, unknown>
        >) {
          if (typeof action['delegate'] === 'string') {
            action['delegate'] = rewriteIfMapped(action['delegate'] as string, renameMap);
          }
          rewriteToolInvocation(action, renameMap);
        }
      }
    }
  }

  // 12. error_handling.handlers[].handoff_target — agent names
  if (ir.error_handling?.handlers) {
    for (const handler of ir.error_handling.handlers) {
      if (handler.handoff_target) {
        handler.handoff_target = rewriteIfMapped(handler.handoff_target, renameMap);
      }
    }
  }
  if (ir.error_handling?.default_handler?.handoff_target) {
    ir.error_handling.default_handler.handoff_target = rewriteIfMapped(
      ir.error_handling.default_handler.handoff_target,
      renameMap,
    );
  }

  // 13. on_start.call (tool name) and on_start.delegate (agent name)
  if (ir.on_start) {
    rewriteToolInvocation(ir.on_start as unknown as Record<string, unknown>, renameMap);
    if (ir.on_start.delegate) {
      ir.on_start.delegate = rewriteIfMapped(ir.on_start.delegate, renameMap);
    }
  }

  // 14. behavior_profiles — tools_hide (tool names), tools_add[].name (tool names)
  if (ir.behavior_profiles) {
    for (const profile of ir.behavior_profiles) {
      if (profile.tools_hide) {
        profile.tools_hide = profile.tools_hide.map((name) => renameMap[name] ?? name);
      }
      if (profile.tools_add) {
        for (const tool of profile.tools_add) {
          tool.name = renameMap[tool.name] ?? tool.name;
        }
      }
      // Profile constraints with handoff actions
      if (profile.constraints) {
        for (const constraint of profile.constraints) {
          rewriteConstraint(constraint, renameMap);
        }
      }
    }
  }

  // 15. hooks — before_agent.call, after_agent.call, before_turn.call, after_turn.call
  if (ir.hooks) {
    for (const hookKey of ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as const) {
      const hook = ir.hooks[hookKey];
      if (hook) {
        rewriteToolInvocation(hook as unknown as Record<string, unknown>, renameMap);
      }
    }
  }

  // 16. agent-level action_handlers — nested CALL actions and handoff/delegate targets
  if (ir.action_handlers) {
    for (const handler of ir.action_handlers) {
      if (handler.do) {
        for (const action of handler.do) {
          rewriteToolInvocation(action as unknown as Record<string, unknown>, renameMap);
          if (action.handoff) {
            action.handoff = rewriteIfMapped(action.handoff, renameMap);
          }
          if (action.delegate) {
            action.delegate = rewriteIfMapped(action.delegate, renameMap);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Rewrites a module's compiled IR so all agent and tool names use the
 * consumer's alias prefix.
 *
 * @param alias - The consumer-assigned alias (e.g. "payments")
 * @param agents - Compiled IR per agent from the module
 * @param tools - Tool definitions from the module
 * @param existingSymbols - Names already in the consumer project (for collision detection)
 * @returns Rewritten agents, tools, rename map, and any collisions
 * @throws If the alias is invalid
 */
export function rewriteModuleIR(
  alias: string,
  agents: Record<string, AgentIR>,
  tools: Record<string, { definition: unknown; toolType: string }>,
  existingSymbols: Set<string>,
): AliasRewriteResult {
  // Validate alias
  const aliasError = validateAlias(alias);
  if (aliasError) {
    throw new Error(aliasError);
  }

  const agentNames = Object.keys(agents);
  const toolNames = Object.keys(tools);

  // Build rename map
  const renameMap = buildRenameMap(alias, agentNames, toolNames);
  const internalNameConflicts = enrichRenameMapWithDeclaredNames(renameMap, agents, tools);
  if (internalNameConflicts.length > 0) {
    throw new Error(
      `Module alias rewrite found ambiguous source symbol(s): ${internalNameConflicts.join(', ')}`,
    );
  }

  // Detect collisions
  const collisions = collectMountedNameCollisions(renameMap, agentNames, toolNames);
  for (const aliasedName of new Set(Object.values(renameMap))) {
    if (existingSymbols.has(aliasedName) && !collisions.includes(aliasedName)) {
      collisions.push(aliasedName);
    }
  }

  if (collisions.length > 0) {
    log.warn('Alias rewrite detected collisions', {
      alias,
      collisions,
      count: collisions.length,
    });
  }

  // Deep-clone and rewrite agents
  const rewrittenAgents: Record<string, ResolvedAgentIR> = {};
  for (const [originalName, agentIR] of Object.entries(agents)) {
    const aliasedName = renameMap[originalName];
    const cloned: AgentIR = JSON.parse(JSON.stringify(agentIR));
    deepRewriteIR(cloned, renameMap);
    rewrittenAgents[aliasedName] = cloned as ResolvedAgentIR;
  }

  // Deep-clone and rewrite tools
  const rewrittenTools: Record<string, ResolvedToolDefinition> = {};
  for (const [originalName, toolEntry] of Object.entries(tools)) {
    const aliasedName = renameMap[originalName];
    const clonedDef = JSON.parse(JSON.stringify(toolEntry.definition));

    // Rewrite the tool's own name if present
    if (clonedDef && typeof clonedDef === 'object' && 'name' in clonedDef) {
      clonedDef.name = aliasedName;
    }

    rewrittenTools[aliasedName] = {
      ...clonedDef,
      tool_type: toolEntry.toolType,
    } as ResolvedToolDefinition;
  }

  log.info('Module IR rewritten with alias', {
    alias,
    agentCount: agentNames.length,
    toolCount: toolNames.length,
    collisionCount: collisions.length,
  });

  return {
    agents: rewrittenAgents,
    tools: rewrittenTools,
    renameMap,
    collisions,
  };
}
