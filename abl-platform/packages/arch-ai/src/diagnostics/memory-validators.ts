/**
 * MEMORY semantic validators — M-01 through M-06.
 *
 * Pure functions operating on compiled AgentIR. No I/O, no side effects.
 *
 * Source IR types: MemoryConfig, SessionMemory, PersistentMemory,
 * RememberTrigger, RecallInstruction from @abl/compiler schema.ts
 *
 * Bounded collections: all Set/Map instances are local to function calls,
 * bounded by the agent's declared fields (typically <50 items), and
 * garbage-collected when the function returns.
 */

import type { AgentIR } from '@abl/compiler';
import type { Finding, ValidatorContext } from './types.js';

/** Max items tracked per agent — defensive bound for local collections. */
const MAX_TRACKED_ITEMS = 500;

/**
 * Validates MEMORY semantics across all agents.
 * Emits: M-01, M-02, M-03, M-04, M-05.
 *
 * M-06 (memory variable in WHEN condition may not be set yet) is deferred —
 * requires cross-construct data flow analysis that depends on execution order.
 */
export function validateMemorySemantics(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const memory = agent.memory;
    if (!memory) continue;

    // Local bounded sets — bounded by agent's declared fields (<50 typical)
    const sessionVarNames = new Set(
      (memory.session ?? []).slice(0, MAX_TRACKED_ITEMS).map((s) => s.name),
    );
    const persistentPaths = new Set(
      (memory.persistent ?? []).slice(0, MAX_TRACKED_ITEMS).map((p) => p.path),
    );

    // Collect all variable references from the agent's constructs
    const referencedVars = collectReferencedVariables(agent);

    // M-01: Session variable declared but never referenced
    for (const sessionVar of memory.session ?? []) {
      if (!referencedVars.has(sessionVar.name)) {
        findings.push({
          code: 'M-01',
          message: `Agent "${name}" declares session variable "${sessionVar.name}" but it is never referenced in constraints, flow, handoffs, or remember/recall`,
          severity: 'info',
          category: 'memory',
          agentName: name,
          path: `memory.session[${sessionVar.name}]`,
        });
      }
    }

    // M-02: Persistent memory path has no scope
    for (const persistent of memory.persistent ?? []) {
      if (!persistent.scope) {
        findings.push({
          code: 'M-02',
          message: `Agent "${name}" persistent memory path "${persistent.path}" has no scope — defaults to "user" scope`,
          severity: 'info',
          category: 'memory',
          agentName: name,
          path: `memory.persistent[${persistent.path}].scope`,
        });
      }
    }

    // M-03: REMEMBER trigger references undefined variable in store.value
    for (const trigger of memory.remember ?? []) {
      const valueVars = extractVariableRefs(trigger.store.value);
      for (const varRef of valueVars) {
        if (!sessionVarNames.has(varRef) && !persistentPaths.has(varRef)) {
          findings.push({
            code: 'M-03',
            message: `Agent "${name}" REMEMBER trigger stores "{{${varRef}}}" but "${varRef}" is not a declared session variable or persistent memory path`,
            severity: 'warning',
            category: 'memory',
            agentName: name,
            path: 'memory.remember',
          });
        }
      }
    }

    // M-04: RECALL references non-existent memory path
    for (const recall of memory.recall ?? []) {
      if (recall.action?.type === 'inject_context' && recall.action.paths) {
        for (const path of recall.action.paths) {
          if (!persistentPaths.has(path) && !sessionVarNames.has(path)) {
            findings.push({
              code: 'M-04',
              message: `Agent "${name}" RECALL injects path "${path}" which is not a declared persistent memory path or session variable`,
              severity: 'error',
              category: 'memory',
              agentName: name,
              path: 'memory.recall',
            });
          }
        }
      }
    }

    // M-05: Persistent memory with write access but no REMEMBER writes to it
    const rememberTargets = new Set(
      (memory.remember ?? []).slice(0, MAX_TRACKED_ITEMS).map((r) => r.store.target),
    );
    for (const persistent of memory.persistent ?? []) {
      if (
        (persistent.access === 'write' || persistent.access === 'readwrite') &&
        !rememberTargets.has(persistent.path)
      ) {
        findings.push({
          code: 'M-05',
          message: `Agent "${name}" persistent memory "${persistent.path}" has write access but no REMEMBER trigger writes to it — memory never populated`,
          severity: 'info',
          category: 'memory',
          agentName: name,
          path: `memory.persistent[${persistent.path}]`,
        });
      }
    }
  }

  return findings;
}

/**
 * Collect all variable names referenced across an agent's constructs.
 * Used by M-01 to detect unused session variables.
 *
 * Returns a bounded Set (capped at MAX_TRACKED_ITEMS). Local to call, GC'd on return.
 */
function collectReferencedVariables(agent: AgentIR): Set<string> {
  const refs: string[] = [];

  // References in constraints
  for (const constraint of agent.constraints?.constraints ?? []) {
    if (constraint.condition) {
      refs.push(...extractVariableRefs(constraint.condition));
    }
  }

  // References in handoff WHEN conditions and PASS fields
  for (const handoff of agent.coordination?.handoffs ?? []) {
    if (handoff.when) {
      refs.push(...extractVariableRefs(handoff.when));
    }
    for (const passField of handoff.context?.pass ?? []) {
      const fieldName = typeof passField === 'string' ? passField : passField.name;
      if (fieldName) refs.push(fieldName);
    }
  }

  // References in completion conditions
  for (const condition of agent.completion?.conditions ?? []) {
    if (condition.when) {
      refs.push(...extractVariableRefs(condition.when));
    }
  }

  // References in flow steps
  if (agent.flow?.definitions) {
    for (const step of Object.values(agent.flow.definitions)) {
      if (step.respond) refs.push(...extractTemplateRefs(step.respond));
      if (step.complete_when) refs.push(...extractVariableRefs(step.complete_when));
      for (const assignment of step.set ?? []) {
        refs.push(assignment.variable);
        if (assignment.expression) refs.push(...extractVariableRefs(assignment.expression));
      }
      if (step.call_as) refs.push(step.call_as);
    }
  }

  // References in remember triggers
  for (const trigger of agent.memory?.remember ?? []) {
    if (trigger.when) refs.push(...extractVariableRefs(trigger.when));
    refs.push(...extractVariableRefs(trigger.store.value));
  }

  // Bounded conversion to Set
  return new Set(refs.slice(0, MAX_TRACKED_ITEMS));
}

/**
 * Extract variable names from a CEL-like expression string.
 * Simple heuristic: matches word characters that look like variable names.
 */
function extractVariableRefs(expression: string): string[] {
  if (!expression) return [];
  const keywords: Record<string, true> = {
    true: true,
    false: true,
    null: true,
    undefined: true,
    AND: true,
    OR: true,
    NOT: true,
    IS: true,
    SET: true,
    IN: true,
    COMPLETE: true,
  };
  const matches = expression.match(/\b[a-zA-Z_]\w*\b/g) ?? [];
  return matches.filter((m) => !keywords[m] && !keywords[m.toUpperCase()]);
}

/**
 * Extract {{variable}} references from template strings.
 */
function extractTemplateRefs(template: string): string[] {
  if (!template) return [];
  const refs: string[] = [];
  const regex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    const expr = match[1].trim();
    const rootVar = expr.split(/[.([]/)[0].trim();
    if (
      rootVar &&
      rootVar !== '#each' &&
      rootVar !== '#if' &&
      rootVar !== '/each' &&
      rootVar !== '/if'
    ) {
      refs.push(rootVar);
    }
  }
  return refs;
}
