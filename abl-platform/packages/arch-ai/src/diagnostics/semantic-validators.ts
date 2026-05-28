/**
 * Semantic validators — pure functions that check AgentIR for logical issues.
 *
 * Each validator returns Finding[] and is stateless (no I/O, no side effects).
 * Validators operate on compiled IR, not raw DSL — parse/compile happens upstream.
 *
 * These are Tier 2 validators. Tier 1 (structural) is in @abl/compiler validateIR.
 */

import {
  BUILTIN_FIELD_REFERENCE_VARS,
  VALIDATION_CODES,
  validateFieldReferences,
  type AgentIR,
} from '@abl/compiler';
import type { Finding, ValidatorContext } from './types.js';
import { validateFlowSemantics } from './flow-validators.js';
import { validateMemorySemantics } from './memory-validators.js';
import { validateBehaviorProfiles } from './behavior-profile-validators.js';

// ═══════════════════════════════════════════════════════════════════════
// HANDOFF VALIDATORS
// Emits: CO-04, H-02, H-03, H-04, H-05, H-06, H-07, H-08, H-09, H-15.
// Rule H-01 remains deferred.
// ═══════════════════════════════════════════════════════════════════════

/**
 * CO-04: Handoff return contract validation.
 *
 * When an agent's handoff has `return: true`, the target must have a COMPLETE
 * block. Runtime return is not a child-side HANDOFF back to the caller; it is
 * performed by the thread return path after the child completes. Emits CO-04.
 *
 * Note: H-01 remains deferred because the current runtime does not expose a
 * distinct target-side RETURN declaration separate from this return-path
 * contract. CO-04 is the active parser/runtime truth today.
 */
export function validateHandoffReturnContract(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const handoffs = agent.coordination?.handoffs ?? [];
    for (const handoff of handoffs) {
      if (!handoff.return) continue;

      // Source expects return — verify target has a return path. Runtime truth:
      // either the child completes/returns, or it explicitly hands control
      // back to the waiting parent thread by targeting the source agent again.
      const target = ctx.agents[handoff.to];
      if (!target) continue; // Cross-agent ref already checked by compiler

      const hasCompletion = (target.completion?.conditions?.length ?? 0) > 0;

      if (!hasCompletion) {
        findings.push({
          code: 'CO-04',
          message: `Agent "${name}" expects return from "${handoff.to}", but "${handoff.to}" has no COMPLETE condition. A child HANDOFF back to "${name}" does not satisfy RETURN: true; the child must COMPLETE so the runtime can return through the parent thread stack.`,
          severity: 'error',
          category: 'completion',
          agentName: name,
          path: `coordination.handoffs[to=${handoff.to}]`,
        });
      }

      const targetHandoffs = target.coordination?.handoffs ?? [];
      const unconditionalBackHandoff = targetHandoffs.find(
        (targetHandoff) => targetHandoff.to === name && isAlwaysTrueCondition(targetHandoff.when),
      );
      if (unconditionalBackHandoff) {
        findings.push({
          code: 'CO-04',
          message: `Agent "${handoff.to}" has an unconditional HANDOFF back to caller "${name}". Runtime evaluates HANDOFF before COMPLETE, so this starts a new nested handoff instead of returning to the parent. Remove the child handoff and let "${handoff.to}" COMPLETE.`,
          severity: 'error',
          category: 'completion',
          agentName: handoff.to,
          path: `coordination.handoffs[to=${name}]`,
        });
      }
    }
  }
  return findings;
}

function isAlwaysTrueCondition(condition: string | undefined): boolean {
  const normalized = (condition ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return normalized === 'true';
}

/** H-02, H-03, H-04, H-08: PASS field existence and compatibility validation. */
export function validatePassFieldExistence(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const handoffs = agent.coordination?.handoffs ?? [];
    const sessionVarNames = new Set((agent.memory?.session ?? []).map((s) => s.name));
    const sessionVarsWithoutKnownPopulation = getSessionVarsWithoutKnownPopulation(agent);
    const sourceGatherTypes = new Map(
      (agent.gather?.fields ?? []).map((field) => [field.name, field.type]),
    );
    const sourceSessionTypes = new Map(
      (agent.memory?.session ?? []).map((sessionVar) => [
        sessionVar.name,
        sessionVar.type ?? 'string',
      ]),
    );
    for (const handoff of handoffs) {
      const passFields = handoff.context?.pass ?? [];
      if (passFields.length === 0) continue;

      // Collect all possible source fields (gather + session vars)
      const gatherFieldNames = new Set((agent.gather?.fields ?? []).map((f) => f.name));

      for (const passField of passFields) {
        const fieldName = typeof passField === 'string' ? passField : passField.name;
        if (!fieldName) continue;

        // H-02: PASS references non-existent GATHER field and not a session var
        if (!gatherFieldNames.has(fieldName) && !sessionVarNames.has(fieldName)) {
          findings.push({
            code: 'H-02',
            message: `Agent "${name}" handoff to "${handoff.to}" passes "${fieldName}" which is not a GATHER field or session variable`,
            severity: 'error',
            category: 'handoff',
            agentName: name,
            path: `coordination.handoffs[to=${handoff.to}].context.pass`,
          });
        }

        // H-03: PASS references a session variable with no initial value or
        // known runtime population source. Warning only: the runtime's
        // __set_context__ tool can still populate it dynamically.
        if (sessionVarNames.has(fieldName) && sessionVarsWithoutKnownPopulation.has(fieldName)) {
          findings.push({
            code: 'H-03',
            message: `Agent "${name}" handoff to "${handoff.to}" passes session variable "${fieldName}" with no initial_value or known population source — target may receive null/undefined unless it is set before handoff`,
            severity: 'warning',
            category: 'handoff',
            agentName: name,
            path: `coordination.handoffs[to=${handoff.to}].context.pass`,
          });
        }

        // H-04/H-08: target declaration and cross-agent type compatibility
        const target = ctx.agents[handoff.to];
        if (target) {
          const targetGatherTypes = new Map(
            (target.gather?.fields ?? []).map((field) => [field.name, field.type]),
          );
          const targetSessionTypes = new Map(
            (target.memory?.session ?? []).map((sessionVar) => [
              sessionVar.name,
              sessionVar.type ?? 'string',
            ]),
          );
          const targetType = targetGatherTypes.get(fieldName) ?? targetSessionTypes.get(fieldName);

          if (!targetType) {
            findings.push({
              code: 'H-04',
              message: `Agent "${name}" passes "${fieldName}" to "${handoff.to}", but target does not declare that field in GATHER or MEMORY.session`,
              severity: 'warning',
              category: 'handoff',
              agentName: name,
              path: `coordination.handoffs[to=${handoff.to}].context.pass`,
            });
            continue;
          }

          const sourceType =
            sourceGatherTypes.get(fieldName) ??
            sourceSessionTypes.get(fieldName) ??
            (typeof passField === 'string' ? undefined : passField.type);

          if (!arePassFieldTypesCompatible(sourceType, targetType)) {
            findings.push({
              code: 'H-08',
              message: `Agent "${name}" passes "${fieldName}" as ${describeTypeForDiagnostic(sourceType)} to "${handoff.to}", but the target declares ${describeTypeForDiagnostic(targetType)}`,
              severity: 'warning',
              category: 'handoff',
              agentName: name,
              path: `coordination.handoffs[to=${handoff.to}].context.pass`,
            });
          }
        }
      }
    }
  }
  return findings;
}

/** H-07: ON_RETURN.map keys must match child fields the runtime can actually return. */
export function validateHandoffReturnMappings(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const handoffs = agent.coordination?.handoffs ?? [];

    for (const handoff of handoffs) {
      if (!handoff.return) continue;

      const returnMap =
        handoff.on_return && typeof handoff.on_return === 'object'
          ? handoff.on_return.map
          : undefined;
      if (!returnMap || Object.keys(returnMap).length === 0) continue;

      const target = ctx.agents[handoff.to];
      if (!target) continue;

      const targetReturnFields = collectKnownReturnOutputFields(target);
      const targetSessionVarsWithoutKnownPopulation = getSessionVarsWithoutKnownPopulation(target);

      for (const [childKey, parentKey] of Object.entries(returnMap)) {
        if (!targetReturnFields.has(childKey)) {
          findings.push({
            code: 'H-07',
            message: `Agent "${name}" maps child field "${childKey}" from "${handoff.to}" into parent field "${parentKey}", but "${handoff.to}" does not declare or obviously produce "${childKey}" in GATHER, MEMORY, tool result mappings, or FLOW state`,
            severity: 'warning',
            category: 'handoff',
            agentName: name,
            path: `coordination.handoffs[to=${handoff.to}].on_return.map`,
          });
          continue;
        }

        if (targetSessionVarsWithoutKnownPopulation.has(childKey)) {
          findings.push({
            code: 'H-07',
            message: `Agent "${name}" maps child field "${childKey}" from "${handoff.to}" into parent field "${parentKey}", but "${handoff.to}" only declares "${childKey}" as session state with no initial_value or known population source — parent may receive null/undefined at runtime`,
            severity: 'warning',
            category: 'handoff',
            agentName: name,
            path: `coordination.handoffs[to=${handoff.to}].on_return.map`,
          });
        }
      }
    }
  }

  return findings;
}

/** H-05: HANDOFF WHEN references undeclared state. */
export function validateHandoffConditionVariables(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const handoffFieldDiagnostics = validateFieldReferences(agent).filter(
      (diagnostic) =>
        diagnostic.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR &&
        diagnostic.path?.startsWith('coordination.handoffs['),
    );

    for (const diagnostic of handoffFieldDiagnostics) {
      const unresolvedVar = diagnostic.message.match(/Variable "([^"]+)"/)?.[1] ?? 'unknown';
      findings.push({
        code: 'H-05',
        message: `Agent "${name}" HANDOFF WHEN references "${unresolvedVar}" which is not a declared gather field, session variable, tool result, or runtime variable`,
        severity: 'error',
        category: 'handoff',
        agentName: name,
        path: diagnostic.path,
      });
    }
  }

  return findings;
}

/** H-06: summary_only requires a real authored summary. */
export function validateHandoffSummaryCoverage(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    for (const handoff of agent.coordination?.handoffs ?? []) {
      if (handoff.context?.history !== 'summary_only') {
        continue;
      }

      if ((handoff.context.summary ?? '').trim().length > 0) {
        continue;
      }

      findings.push({
        code: 'H-06',
        message: `Agent "${name}" uses history: summary_only for handoff to "${handoff.to}" but provides no CONTEXT.summary — runtime suppresses parent transcript history, so the child may receive almost no continuity`,
        severity: 'warning',
        category: 'handoff',
        agentName: name,
        path: `coordination.handoffs[to=${handoff.to}].context.summary`,
      });
    }
  }

  return findings;
}

/** H-15: Parent expects child return state that default merge will not carry back. */
export function validateReturnStateCoverage(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const returnDependentVars = collectReturnDependentSessionVars(agent);
    if (returnDependentVars.size === 0) {
      continue;
    }

    const sessionVarsWithoutKnownPopulation = getSessionVarsWithoutKnownPopulation(agent);
    const unresolvedReturnNeeds = [...returnDependentVars].filter((sessionVar) =>
      sessionVarsWithoutKnownPopulation.has(sessionVar),
    );
    if (unresolvedReturnNeeds.length === 0) {
      continue;
    }

    for (const handoff of agent.coordination?.handoffs ?? []) {
      if (!handoff.return) {
        continue;
      }

      const target = ctx.agents[handoff.to];
      if (!target) {
        continue;
      }

      const returnMap =
        handoff.on_return && typeof handoff.on_return === 'object'
          ? handoff.on_return.map
          : undefined;
      const mappedParentVars = new Set(Object.values(returnMap ?? {}));
      const childGatherFields = new Set((target.gather?.fields ?? []).map((field) => field.name));
      const childKnownReturnFields = collectKnownReturnOutputFields(target);

      const uncoveredVars = unresolvedReturnNeeds.filter((parentVar) => {
        if (mappedParentVars.has(parentVar)) {
          return false;
        }

        if (childGatherFields.has(parentVar)) {
          return false;
        }

        return childKnownReturnFields.has(parentVar);
      });

      if (uncoveredVars.length === 0) {
        continue;
      }

      findings.push({
        code: 'H-15',
        message: `Agent "${name}" uses ${uncoveredVars.join(', ')} in its own completion/routing logic after RETURN from "${handoff.to}", but "${handoff.to}" only obviously produces those values outside the default gathered-data merge. Add ON_RETURN.map or rename the parent state contract.`,
        severity: 'warning',
        category: 'handoff',
        agentName: name,
        path: `coordination.handoffs[to=${handoff.to}].on_return.map`,
      });
    }
  }

  return findings;
}

/** H-09: Overlapping handoff conditions. */
export function validateRoutingConflicts(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const handoffs = agent.coordination?.handoffs ?? [];
    const conditionalHandoffs = handoffs.filter((h) => h.when);

    // Check for handoffs with identical WHEN conditions
    for (let i = 0; i < conditionalHandoffs.length; i++) {
      for (let j = i + 1; j < conditionalHandoffs.length; j++) {
        const a = conditionalHandoffs[i];
        const b = conditionalHandoffs[j];
        if (a.when === b.when) {
          findings.push({
            code: 'H-09',
            message: `Agent "${name}" has handoffs to "${a.to}" and "${b.to}" with identical WHEN conditions`,
            severity: 'warning',
            category: 'handoff',
            agentName: name,
          });
        }
      }
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// COMPLETION VALIDATORS (CO-01, CO-02, CO-03, SV-13)
// ═══════════════════════════════════════════════════════════════════════

/** CO-01, SV-13: Completion reachability. */
export function validateCompletionReachability(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const conditions = agent.completion?.conditions ?? [];
    const hasGather = (agent.gather?.fields?.length ?? 0) > 0;
    const hasFlow = Boolean(agent.flow);
    const isSupervisor =
      (agent.coordination?.handoffs?.length ?? 0) > 0 || (agent.routing?.rules?.length ?? 0) > 0;
    const sessionNames = new Set(
      (agent.memory?.session ?? []).map((sessionVar) => sessionVar.name),
    );
    const gatherFields = agent.gather?.fields ?? [];
    const gatherNames = new Set(gatherFields.map((field) => field.name));
    const optionalGatherNames = new Set(
      gatherFields
        .filter((field) => field.required === false || field.activation === 'optional')
        .map((field) => field.name),
    );

    // CO-01: No completion conditions (skip supervisors — they route, not complete)
    if (conditions.length === 0 && !isSupervisor) {
      findings.push({
        code: 'CO-01',
        message: `Agent "${name}" has no COMPLETION conditions — conversation may run indefinitely`,
        severity: 'warning',
        category: 'completion',
        agentName: name,
      });
    }

    // CO-02: COMPLETION references undeclared state. Use the compiler's
    // field-reference validator as the source of truth so semantic diagnostics
    // stay aligned with the parser/compiler contract.
    const completionFieldDiagnostics = validateFieldReferences(agent).filter(
      (diagnostic) =>
        diagnostic.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR &&
        diagnostic.path?.startsWith('completion.conditions['),
    );

    for (const diagnostic of completionFieldDiagnostics) {
      const unresolvedVar = diagnostic.message.match(/Variable "([^"]+)"/)?.[1] ?? 'unknown';
      findings.push({
        code: 'CO-02',
        message: `Agent "${name}" COMPLETION references "${unresolvedVar}" which is not a declared gather field, session variable, tool result, or runtime variable`,
        severity: 'error',
        category: 'completion',
        agentName: name,
        path: diagnostic.path,
      });
    }

    // CO-03: Every COMPLETION condition depends only on optional gather fields.
    // Runtime gather completeness does not block on these fields, so the agent
    // may wait forever unless the user volunteers them unprompted.
    const optionalOnlyCompletionConditions = conditions.filter((condition) => {
      const identifiers = extractIdentifiers(condition.when ?? '');
      const nonRuntimeRefs = identifiers.filter(
        (identifier) => !RUNTIME_CONDITION_VARS.has(identifier),
      );
      if (nonRuntimeRefs.length === 0) return false;
      if (!nonRuntimeRefs.every((identifier) => gatherNames.has(identifier))) return false;
      return nonRuntimeRefs.every((identifier) => optionalGatherNames.has(identifier));
    });

    if (
      conditions.length > 0 &&
      !hasFlow &&
      optionalOnlyCompletionConditions.length === conditions.length
    ) {
      const optionalFields = [
        ...new Set(
          optionalOnlyCompletionConditions.flatMap((condition) => {
            const identifiers = extractIdentifiers(condition.when ?? '');
            return identifiers.filter((identifier) => optionalGatherNames.has(identifier));
          }),
        ),
      ];
      findings.push({
        code: 'CO-03',
        message: `Agent "${name}" COMPLETION depends only on optional gather fields (${optionalFields.join(', ')}) — runtime will not require those fields, so the agent may never complete`,
        severity: 'error',
        category: 'completion',
        agentName: name,
        path: 'completion.conditions',
      });
    }

    // SV-13: Has completion but no way to make progress
    const hasSelfContainedCompletion = conditions.some((condition) => {
      const identifiers = extractIdentifiers(condition.when ?? '');
      return identifiers.every(
        (identifier) => sessionNames.has(identifier) || RUNTIME_CONDITION_VARS.has(identifier),
      );
    });

    if (conditions.length > 0 && !hasGather && !hasFlow && !hasSelfContainedCompletion) {
      findings.push({
        code: 'SV-13',
        message: `Agent "${name}" has COMPLETION conditions but no GATHER or FLOW to make progress toward them`,
        severity: 'error',
        category: 'completion',
        agentName: name,
      });
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL VALIDATORS (T-01 through T-10)
// ═══════════════════════════════════════════════════════════════════════

/** T-01 through T-10: Tool configuration quality. */
export function validateToolConfig(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const tools = agent.tools ?? [];

    // T-10: Too many tools
    if (tools.length > 15) {
      findings.push({
        code: 'T-10',
        message: `Agent "${name}" has ${tools.length} tools — LLM may struggle to select correctly (recommend ≤15)`,
        severity: 'info',
        category: 'tool',
        agentName: name,
      });
    }

    for (const tool of tools) {
      // Skip system-injected tools (__handoff__, __complete__, __escalate__, __delegate__)
      // — these are auto-generated by the compiler with correct config, no user validation needed.
      if (tool.system || tool.name.startsWith('__')) continue;

      // T-01: No description
      if (!tool.description?.trim()) {
        findings.push({
          code: 'T-01',
          message: `Agent "${name}" tool "${tool.name}" has no description — LLM cannot determine when to use it`,
          severity: 'warning',
          category: 'tool',
          agentName: name,
          path: `tools[${tool.name}].description`,
        });
      }

      // T-02: Parameter without description
      for (const param of tool.parameters ?? []) {
        if (!param.description?.trim()) {
          findings.push({
            code: 'T-02',
            message: `Agent "${name}" tool "${tool.name}" param "${param.name}" has no description`,
            severity: 'info',
            category: 'tool',
            agentName: name,
            path: `tools[${tool.name}].parameters[${param.name}]`,
          });
        }
      }

      // T-04: No binding at all
      const toolAny = tool as unknown as Record<string, unknown>;
      const hasBinding = Boolean(
        tool.http_binding ||
        tool.mcp_binding ||
        tool.sandbox_binding ||
        tool.connector_binding ||
        tool.workflow_binding ||
        toolAny.searchai_binding ||
        toolAny.async_webhook_binding,
      );
      if (!hasBinding) {
        findings.push({
          code: 'T-04',
          message: `Agent "${name}" tool "${tool.name}" has no binding (HTTP, MCP, sandbox, etc.) — cannot execute`,
          severity: 'error',
          category: 'tool',
          agentName: name,
          path: `tools[${tool.name}]`,
        });
      }

      // T-08: Side effects without confirmation
      if (tool.hints?.side_effects && !tool.confirmation) {
        findings.push({
          code: 'T-08',
          message: `Agent "${name}" tool "${tool.name}" has side_effects but no confirmation configured`,
          severity: 'warning',
          category: 'tool',
          agentName: name,
          path: `tools[${tool.name}].confirmation`,
        });
      }
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// GATHER VALIDATORS (G-01 through G-08, SV-12)
// ═══════════════════════════════════════════════════════════════════════

/** G-01 through G-08: Gather field quality. */
export function validateGatherQuality(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const fields = agent.gather?.fields ?? [];

    // G-08: Too many fields
    if (fields.length > 20) {
      findings.push({
        code: 'G-08',
        message: `Agent "${name}" has ${fields.length} GATHER fields — consider splitting into multiple agents`,
        severity: 'info',
        category: 'gather',
        agentName: name,
      });
    }

    const fieldNames = new Set(fields.map((f) => f.name));

    for (const field of fields) {
      // G-01: No prompt
      if (!field.prompt?.trim()) {
        findings.push({
          code: 'G-01',
          message: `Agent "${name}" GATHER field "${field.name}" has no prompt`,
          severity: 'warning',
          category: 'gather',
          agentName: name,
          path: `gather.fields[${field.name}].prompt`,
        });
      }

      // G-02: depends_on references non-existent field
      for (const dep of field.depends_on ?? []) {
        if (!fieldNames.has(dep)) {
          findings.push({
            code: 'G-02',
            message: `Agent "${name}" field "${field.name}" depends_on "${dep}" which does not exist`,
            severity: 'error',
            category: 'gather',
            agentName: name,
            path: `gather.fields[${field.name}].depends_on`,
          });
        }
      }

      // G-06: infer without extraction_hints
      if (field.infer && (!field.extraction_hints || field.extraction_hints.length === 0)) {
        findings.push({
          code: 'G-06',
          message: `Agent "${name}" field "${field.name}" has infer: true but no extraction_hints`,
          severity: 'info',
          category: 'gather',
          agentName: name,
          path: `gather.fields[${field.name}]`,
        });
      }

      // G-07: Sensitive without mask_config
      if (field.sensitive && !field.mask_config) {
        findings.push({
          code: 'G-07',
          message: `Agent "${name}" field "${field.name}" is sensitive but has no mask_config`,
          severity: 'warning',
          category: 'gather',
          agentName: name,
          path: `gather.fields[${field.name}].mask_config`,
        });
      }

      // SV-12: Optional field with validation but no default
      if (field.validation && !field.required && field.default === undefined) {
        findings.push({
          code: 'SV-12',
          message: `Agent "${name}" field "${field.name}" has validation but is optional with no default`,
          severity: 'warning',
          category: 'gather',
          agentName: name,
          path: `gather.fields[${field.name}]`,
        });
      }
    }

    // G-03: Circular depends_on (DFS cycle detection)
    const circularFields = detectGatherCycles(fields);
    for (const fieldName of circularFields) {
      findings.push({
        code: 'G-03',
        message: `Agent "${name}" GATHER field "${fieldName}" has circular depends_on chain`,
        severity: 'error',
        category: 'gather',
        agentName: name,
        path: `gather.fields[${fieldName}].depends_on`,
      });
    }
  }
  return findings;
}

/** Detect cycles in gather field dependency graph. */
function detectGatherCycles(fields: AgentIR['gather']['fields']): string[] {
  const graph = new Map<string, string[]>();
  for (const field of fields) {
    graph.set(field.name, field.depends_on ?? []);
  }

  const cycleFields: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function dfs(node: string): boolean {
    if (visiting.has(node)) return true; // cycle
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (dfs(dep)) {
        cycleFields.push(node);
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const field of fields) {
    dfs(field.name);
  }
  return cycleFields;
}

// ═══════════════════════════════════════════════════════════════════════
// CONSTRAINT VALIDATORS (C-01 through C-10)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract identifiers from a CEL-like expression string.
 * Defined here so C-07 and G-09 don't need a cross-module import.
 */
function extractIdentifiers(expression: string): string[] {
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

/** Extract {{variable}} double-brace references from template strings. */
function extractBraceRefs(template: string): string[] {
  if (!template) return [];
  const refs: string[] = [];
  for (const m of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    const root = m[1].trim().split(/[.([]/)[0].trim();
    if (root && !['#each', '#if', '/each', '/if'].includes(root)) refs.push(root);
  }
  return refs;
}

function addRootValue(target: Set<string>, value: string | undefined): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }

  target.add(value.split('.')[0]);
}

function addRootKeysFromRecord(
  target: Set<string>,
  record: Record<string, unknown> | undefined,
): void {
  if (!record) {
    return;
  }

  for (const key of Object.keys(record)) {
    addRootValue(target, key);
  }
}

function addKnownReturnField(target: Set<string>, value: string | undefined): void {
  if (typeof value !== 'string') {
    return;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }

  target.add(trimmed);
  addRootValue(target, trimmed);
}

function addKnownReturnFieldsFromRecord(
  target: Set<string>,
  record: Record<string, unknown> | undefined,
): void {
  if (!record) {
    return;
  }

  for (const key of Object.keys(record)) {
    addKnownReturnField(target, key);
  }
}

function getDigressionActions(digression: {
  do?: Array<{
    set?: Record<string, unknown>;
    on_return?: { map?: Record<string, string> };
  }>;
  set?: Record<string, unknown>;
}): Array<{
  set?: Record<string, unknown>;
  on_return?: { map?: Record<string, string> };
}> {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  if (digression.set) {
    return [{ set: digression.set }];
  }

  return [];
}

function collectKnownReturnOutputFields(agent: AgentIR): Set<string> {
  const outputs = new Set<string>();

  for (const field of agent.gather?.fields ?? []) {
    addKnownReturnField(outputs, field.name);
  }

  for (const sessionVar of agent.memory?.session ?? []) {
    addKnownReturnField(outputs, sessionVar.name);
  }

  for (const persistent of agent.memory?.persistent ?? []) {
    addKnownReturnField(outputs, persistent.path);
  }

  for (const recall of agent.memory?.recall ?? []) {
    if (recall.action?.type === 'inject_context') {
      for (const path of recall.action.paths) {
        addKnownReturnField(outputs, path);
      }
    }
  }

  addKnownReturnFieldsFromRecord(outputs, agent.on_start?.set);

  for (const tool of agent.tools ?? []) {
    addKnownReturnField(outputs, `last_${tool.name}_result`);
    addKnownReturnFieldsFromRecord(outputs, tool.on_result?.set);
    addKnownReturnFieldsFromRecord(outputs, tool.on_error?.set);

    for (const fieldName of Object.keys(tool.returns?.fields ?? {})) {
      addKnownReturnField(outputs, fieldName);
    }
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    if (handoff.on_return && typeof handoff.on_return === 'object' && handoff.on_return.map) {
      for (const parentVar of Object.values(handoff.on_return.map)) {
        addKnownReturnField(outputs, parentVar);
      }
    }
  }

  for (const delegate of agent.coordination?.delegates ?? []) {
    addKnownReturnField(outputs, delegate.use_result);
    for (const parentVar of Object.values(delegate.returns ?? {})) {
      addKnownReturnField(outputs, parentVar);
    }
  }

  for (const handler of agent.action_handlers ?? []) {
    addKnownReturnFieldsFromRecord(outputs, handler.set);
  }

  for (const step of Object.values(agent.flow?.definitions ?? {})) {
    for (const assignment of step.set ?? []) {
      addKnownReturnField(outputs, assignment.variable);
    }

    for (const field of step.gather?.fields ?? []) {
      addKnownReturnField(outputs, field.name);
    }

    addKnownReturnField(outputs, step.call_as);
    addKnownReturnField(outputs, step.transform?.target);

    const branchSetSources = [
      ...(step.on_input ?? []),
      ...(step.on_result ?? []),
      ...(step.on_success?.branches ?? []),
      ...(step.on_failure?.branches ?? []),
      ...(step.on_action ?? []),
    ];

    for (const branch of branchSetSources) {
      addKnownReturnFieldsFromRecord(outputs, branch.set);
    }

    for (const digression of step.digressions ?? []) {
      for (const action of getDigressionActions(digression)) {
        addKnownReturnFieldsFromRecord(outputs, action.set);

        for (const parentVar of Object.values(action.on_return?.map ?? {})) {
          addKnownReturnField(outputs, parentVar);
        }
      }
    }

    for (const subIntent of step.sub_intents ?? []) {
      addKnownReturnFieldsFromRecord(outputs, subIntent.set);
    }
  }

  for (const digression of agent.flow?.global_digressions ?? []) {
    for (const action of getDigressionActions(digression)) {
      addKnownReturnFieldsFromRecord(outputs, action.set);

      for (const parentVar of Object.values(action.on_return?.map ?? {})) {
        addKnownReturnField(outputs, parentVar);
      }
    }
  }

  return outputs;
}

function collectReturnDependentSessionVars(agent: AgentIR): Set<string> {
  const sessionNames = new Set((agent.memory?.session ?? []).map((sessionVar) => sessionVar.name));
  if (sessionNames.size === 0) {
    return new Set<string>();
  }

  const dependentVars = new Set<string>();
  const addIfSessionVar = (value: string): void => {
    if (sessionNames.has(value)) {
      dependentVars.add(value);
    }
  };

  for (const condition of agent.completion?.conditions ?? []) {
    for (const identifier of extractIdentifiers(condition.when ?? '')) {
      addIfSessionVar(identifier);
    }
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    if (handoff.when) {
      for (const identifier of extractIdentifiers(handoff.when)) {
        addIfSessionVar(identifier);
      }
    }

    for (const passField of handoff.context?.pass ?? []) {
      const fieldName = typeof passField === 'string' ? passField : passField.name;
      if (fieldName) {
        addIfSessionVar(fieldName);
      }
    }

    for (const identifier of extractBraceRefs(handoff.context?.summary ?? '')) {
      addIfSessionVar(identifier);
    }
  }

  for (const constraint of agent.constraints?.constraints ?? []) {
    for (const identifier of extractIdentifiers(constraint.condition ?? '')) {
      addIfSessionVar(identifier);
    }
  }

  for (const step of Object.values(agent.flow?.definitions ?? {})) {
    for (const identifier of extractIdentifiers(step.complete_when ?? '')) {
      addIfSessionVar(identifier);
    }

    for (const identifier of extractBraceRefs(step.respond ?? '')) {
      addIfSessionVar(identifier);
    }

    for (const assignment of step.set ?? []) {
      for (const identifier of extractIdentifiers(assignment.expression ?? '')) {
        addIfSessionVar(identifier);
      }
    }
  }

  return dependentVars;
}

function getSessionVarsWithoutKnownPopulation(agent: AgentIR): Set<string> {
  const declaredSessionVars = agent.memory?.session ?? [];
  if (declaredSessionVars.length === 0) {
    return new Set<string>();
  }

  const populated = new Set<string>();

  for (const sessionVar of declaredSessionVars) {
    if (sessionVar.initial_value !== undefined) {
      populated.add(sessionVar.name);
    }
  }

  for (const field of agent.gather?.fields ?? []) {
    populated.add(field.name);
  }

  for (const tool of agent.tools ?? []) {
    addRootKeysFromRecord(populated, tool.on_result?.set);
    addRootKeysFromRecord(populated, tool.on_error?.set);
    if (tool.store_result !== false) {
      populated.add(`last_${tool.name}_result`);
    }
  }

  for (const remember of agent.memory?.remember ?? []) {
    addRootValue(populated, remember.store.target);
  }

  for (const recall of agent.memory?.recall ?? []) {
    if (recall.action?.type === 'inject_context') {
      for (const path of recall.action.paths) {
        addRootValue(populated, path);
      }
    }
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    if (handoff.on_return && typeof handoff.on_return === 'object' && handoff.on_return.map) {
      for (const parentVar of Object.values(handoff.on_return.map)) {
        addRootValue(populated, parentVar);
      }
    }
  }

  for (const delegate of agent.coordination?.delegates ?? []) {
    for (const parentVar of Object.values(delegate.returns ?? {})) {
      addRootValue(populated, parentVar);
    }
  }

  for (const handler of agent.action_handlers ?? []) {
    addRootKeysFromRecord(populated, handler.set);
  }

  for (const step of Object.values(agent.flow?.definitions ?? {})) {
    for (const assignment of step.set ?? []) {
      addRootValue(populated, assignment.variable);
    }

    for (const field of step.gather?.fields ?? []) {
      populated.add(field.name);
    }

    addRootValue(populated, step.transform?.target);

    const branchSetSources = [
      ...(step.on_input ?? []),
      ...(step.on_result ?? []),
      ...(step.on_success?.branches ?? []),
      ...(step.on_failure?.branches ?? []),
      ...(step.on_action ?? []),
    ];

    for (const branch of branchSetSources) {
      addRootKeysFromRecord(populated, branch.set);
    }

    for (const subIntent of step.sub_intents ?? []) {
      addRootKeysFromRecord(populated, subIntent.set);
    }
  }

  return new Set(
    declaredSessionVars
      .map((sessionVar) => sessionVar.name)
      .filter((sessionVarName) => !populated.has(sessionVarName)),
  );
}

// Variables the runtime/compiler expose in condition expressions without
// explicit declaration. Shared with compiler field-reference validation so
// semantic diagnostics stay aligned with the parser/runtime contract.
const RUNTIME_CONDITION_VARS = new Set<string>(BUILTIN_FIELD_REFERENCE_VARS);

function normalizePassFieldType(type: string | undefined): string {
  const raw = type?.trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.startsWith('enum(')) return 'string';
  if (raw === 'email' || raw === 'phone' || raw === 'date' || raw === 'datetime') return 'string';
  if (raw === 'integer' || raw === 'float') return 'number';
  if (raw === 'bool') return 'boolean';
  return raw;
}

function arePassFieldTypesCompatible(
  sourceType: string | undefined,
  targetType: string | undefined,
): boolean {
  const normalizedSource = normalizePassFieldType(sourceType);
  const normalizedTarget = normalizePassFieldType(targetType);

  if (normalizedSource === 'unknown' || normalizedTarget === 'unknown') {
    return true;
  }

  return normalizedSource === normalizedTarget;
}

function describeTypeForDiagnostic(type: string | undefined): string {
  return type?.trim().length ? `"${type.trim()}"` : '"unknown"';
}

/** C-01 through C-10: Constraint semantics. */
export function validateConstraintSemantics(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const constraints = agent.constraints?.constraints ?? [];

    // C-10: Too many constraints
    if (constraints.length > 10) {
      findings.push({
        code: 'C-10',
        message: `Agent "${name}" has ${constraints.length} constraints — consider consolidation`,
        severity: 'info',
        category: 'constraint',
        agentName: name,
      });
    }

    const gatherNames = new Set((agent.gather?.fields ?? []).map((f) => f.name));
    const sessionNames = new Set((agent.memory?.session ?? []).map((s) => s.name));

    for (const constraint of constraints) {
      // C-04: No on_fail action
      if (!constraint.on_fail) {
        findings.push({
          code: 'C-04',
          message: `Agent "${name}" has a constraint with no on_fail action`,
          severity: 'warning',
          category: 'constraint',
          agentName: name,
          path: 'constraints',
        });
      }

      // C-08: Error-severity constraint with respond (should block)
      if (constraint.severity === 'error' && constraint.on_fail?.type === 'respond') {
        findings.push({
          code: 'C-08',
          message: `Agent "${name}" has error-severity constraint with on_fail: respond — should use block or escalate`,
          severity: 'warning',
          category: 'constraint',
          agentName: name,
          path: 'constraints',
        });
      }

      // C-07: Constraint references a variable that cannot be resolved at runtime.
      // Catches the very common LLM-generated `user_authenticated` pattern — the
      // identifier has no ABL runtime source so the REQUIRE always evaluates wrong.
      if (constraint.condition) {
        for (const id of extractIdentifiers(constraint.condition)) {
          if (!gatherNames.has(id) && !sessionNames.has(id) && !RUNTIME_CONDITION_VARS.has(id)) {
            findings.push({
              code: 'C-07',
              message: `Agent "${name}" constraint references "${id}" which is not a GATHER field, session variable, or runtime variable — always evaluates incorrectly. Declare "${id}" in MEMORY.session, or remove this constraint.`,
              severity: 'warning',
              category: 'constraint',
              agentName: name,
              path: 'constraints',
            });
          }
        }
      }
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// GATHER COMPLETENESS VALIDATOR (G-09)
// ═══════════════════════════════════════════════════════════════════════

/**
 * G-09: GATHER field declared but never used.
 *
 * A GATHER field not referenced in COMPLETE WHEN conditions, HANDOFF PASS
 * blocks, CONSTRAINT conditions, FLOW step templates, or a parent return
 * contract wastes LLM turns collecting data that is silently discarded.
 * The GATHER-layer analogue of M-01 (unused session variable).
 */
export function validateGatherCompleteness(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];
  const incomingReturnUsage = collectIncomingReturnUsage(ctx);

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const gatherFields = agent.gather?.fields ?? [];
    if (gatherFields.length === 0) continue;

    const used = new Set<string>();
    const returnUsage = incomingReturnUsage[name];

    // 1. COMPLETE WHEN conditions
    for (const cond of agent.completion?.conditions ?? []) {
      if (cond.when) for (const v of extractIdentifiers(cond.when)) used.add(v);
    }

    // 2. HANDOFF PASS fields + WHEN conditions
    for (const handoff of agent.coordination?.handoffs ?? []) {
      for (const pf of handoff.context?.pass ?? []) {
        const fn = typeof pf === 'string' ? pf : pf.name;
        if (fn) used.add(fn);
      }
      if (handoff.when) for (const v of extractIdentifiers(handoff.when)) used.add(v);
      if (handoff.context?.summary) {
        for (const v of extractBraceRefs(handoff.context.summary)) used.add(v);
      }
    }

    // 3. CONSTRAINT conditions
    for (const c of agent.constraints?.constraints ?? []) {
      if (c.condition) for (const v of extractIdentifiers(c.condition)) used.add(v);
    }

    // 4. FLOW step RESPOND/CALL templates and SET expressions
    if (agent.flow?.definitions) {
      for (const step of Object.values(agent.flow.definitions)) {
        for (const flowField of step.gather?.fields ?? []) {
          used.add(flowField.name);
        }
        if (step.respond) for (const v of extractBraceRefs(step.respond)) used.add(v);
        if (step.call) {
          for (const v of extractBraceRefs(step.call)) used.add(v);
          for (const v of extractIdentifiers(step.call)) used.add(v);
        }
        for (const a of step.set ?? []) {
          used.add(a.variable);
          if (a.expression) for (const v of extractIdentifiers(a.expression)) used.add(v);
        }
        if (step.complete_when) for (const v of extractIdentifiers(step.complete_when)) used.add(v);
      }
    }

    // 5. REMEMBER triggers that capture GATHER field values
    for (const trigger of agent.memory?.remember ?? []) {
      for (const v of extractIdentifiers(trigger.store.value)) used.add(v);
    }

    // 6. Parent return contracts. RETURN: true default-merges child GATHER
    // fields by same name; ON_RETURN.map can also name explicit child fields.
    for (const fieldName of returnUsage?.fieldNames ?? []) {
      used.add(fieldName);
    }

    for (const field of gatherFields) {
      if (!used.has(field.name)) {
        const returnSourceNames = [...(returnUsage?.sourceNames ?? [])].sort();
        const isReturnTarget = returnSourceNames.length > 0;
        findings.push({
          code: 'G-09',
          message: isReturnTarget
            ? `Agent "${name}" GATHER field "${field.name}" is collected but not referenced by local completion, handoff context, constraints, flow, or its parent return contract from ${returnSourceNames.join(', ')}. Because "${name}" is a RETURN target, do not remove GATHER or COMPLETE just to silence this warning; either wire "${field.name}" into the return/completion contract or replace it with a field that preserves the return path.`
            : `Agent "${name}" GATHER field "${field.name}" is collected but never used in COMPLETE, HANDOFF PASS, CONSTRAINTS, FLOW, or parent return contracts — remove it only if no caller depends on it, or reference it in the completion/return contract`,
          severity: 'warning',
          category: 'gather',
          agentName: name,
          path: `gather.fields[${field.name}]`,
          fix: {
            description: isReturnTarget
              ? 'Preserve the return contract: wire this field into COMPLETE, parent ON_RETURN/default merge usage, FLOW, or replace it with the correct domain completion field.'
              : 'Remove the unused field, or wire it into COMPLETE, HANDOFF context, FLOW, constraints, or a parent return contract.',
            effort: 'S',
          },
        });
      }
    }
  }

  return findings;
}

interface IncomingReturnUsage {
  sourceNames: Set<string>;
  fieldNames: Set<string>;
}

function collectIncomingReturnUsage(ctx: ValidatorContext): Record<string, IncomingReturnUsage> {
  const usageByTarget: Record<string, IncomingReturnUsage> = {};

  for (const [sourceName, sourceAgent] of Object.entries(ctx.agents)) {
    const sourceRefs = collectGatherReturnConsumerRefs(sourceAgent);

    for (const handoff of sourceAgent.coordination?.handoffs ?? []) {
      if (!handoff.return) {
        continue;
      }

      const targetUsage = (usageByTarget[handoff.to] ??= {
        sourceNames: new Set<string>(),
        fieldNames: new Set<string>(),
      });
      targetUsage.sourceNames.add(sourceName);

      if (handoff.on_return && typeof handoff.on_return === 'object' && handoff.on_return.map) {
        for (const childField of Object.keys(handoff.on_return.map)) {
          targetUsage.fieldNames.add(childField);
        }
      }

      // Default RETURN merge copies child gathered fields back to the parent
      // under the same name. If the parent references a field name anywhere in
      // its own declarative state, that child field is not truly unused.
      for (const fieldName of sourceRefs) {
        targetUsage.fieldNames.add(fieldName);
      }
    }
  }

  return usageByTarget;
}

function collectGatherReturnConsumerRefs(agent: AgentIR): Set<string> {
  const refs = new Set<string>();

  for (const cond of agent.completion?.conditions ?? []) {
    if (cond.when) for (const v of extractIdentifiers(cond.when)) refs.add(v);
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    for (const pf of handoff.context?.pass ?? []) {
      const fn = typeof pf === 'string' ? pf : pf.name;
      if (fn) refs.add(fn);
    }
    if (handoff.when) for (const v of extractIdentifiers(handoff.when)) refs.add(v);
    if (handoff.context?.summary) {
      for (const v of extractBraceRefs(handoff.context.summary)) refs.add(v);
    }
  }

  for (const constraint of agent.constraints?.constraints ?? []) {
    if (constraint.condition) {
      for (const v of extractIdentifiers(constraint.condition)) refs.add(v);
    }
  }

  for (const trigger of agent.memory?.remember ?? []) {
    if (trigger.when) for (const v of extractIdentifiers(trigger.when)) refs.add(v);
    for (const v of extractIdentifiers(trigger.store.value)) refs.add(v);
  }

  if (agent.flow?.definitions) {
    for (const step of Object.values(agent.flow.definitions)) {
      for (const flowField of step.gather?.fields ?? []) {
        refs.add(flowField.name);
      }
      if (step.respond) for (const v of extractBraceRefs(step.respond)) refs.add(v);
      if (step.call) {
        for (const v of extractBraceRefs(step.call)) refs.add(v);
        for (const v of extractIdentifiers(step.call)) refs.add(v);
      }
      for (const assignment of step.set ?? []) {
        refs.add(assignment.variable);
        if (assignment.expression) {
          for (const v of extractIdentifiers(assignment.expression)) refs.add(v);
        }
      }
      if (step.complete_when) {
        for (const v of extractIdentifiers(step.complete_when)) refs.add(v);
      }
    }
  }

  return refs;
}

// ═══════════════════════════════════════════════════════════════════════
// IDENTITY / OTHER VALIDATORS (O-01, O-02, O-03, E-01 through E-07)
// ═══════════════════════════════════════════════════════════════════════

/** O-01, O-02, O-03: Agent identity quality. E-01 through E-07: Execution config. */
export function validateAgentIdentity(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    // O-02: No GOAL
    if (!agent.identity?.goal?.trim()) {
      findings.push({
        code: 'O-02',
        message: `Agent "${name}" has no GOAL defined — LLM has no objective function`,
        severity: 'warning',
        category: 'other',
        agentName: name,
        path: 'identity.goal',
      });
    }

    // O-01: No PERSONA
    if (!agent.identity?.persona?.trim()) {
      findings.push({
        code: 'O-01',
        message: `Agent "${name}" has no PERSONA — will use generic tone`,
        severity: 'info',
        category: 'other',
        agentName: name,
        path: 'identity.persona',
      });
    }

    // E-03: max_iterations too low for reasoning agents
    const maxIter = agent.execution?.max_iterations;
    const isReasoning = agent.execution?.mode === 'reasoning';
    if (isReasoning && maxIter !== undefined && maxIter < 2) {
      findings.push({
        code: 'E-03',
        message: `Agent "${name}" is reasoning mode with max_iterations=${maxIter} — cannot complete multi-step tasks`,
        severity: 'warning',
        category: 'execution',
        agentName: name,
        path: 'execution.max_iterations',
      });
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// NAMING VALIDATORS (O-04, O-06, SV-11)
// ═══════════════════════════════════════════════════════════════════════

/** O-06, SV-11: Agent naming issues. */
export function validateAgentNaming(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];
  const names = ctx.agentNames;

  // O-06: Duplicate names (case-insensitive)
  const lowerNames = new Map<string, string[]>();
  for (const name of names) {
    const lower = name.toLowerCase();
    const existing = lowerNames.get(lower) ?? [];
    existing.push(name);
    lowerNames.set(lower, existing);
  }
  for (const [, group] of lowerNames) {
    if (group.length > 1) {
      findings.push({
        code: 'O-06',
        message: `Duplicate agent names (case-insensitive): ${group.join(', ')}`,
        severity: 'error',
        category: 'naming',
        agentName: null,
      });
    }
  }

  // SV-11: Similar names (Levenshtein distance ≤ 2)
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (
        levenshtein(names[i], names[j]) <= 2 &&
        names[i].toLowerCase() !== names[j].toLowerCase()
      ) {
        findings.push({
          code: 'SV-11',
          message: `Agent names "${names[i]}" and "${names[j]}" are very similar — may cause confusion`,
          severity: 'info',
          category: 'naming',
          agentName: null,
        });
      }
    }
  }

  return findings;
}

/** Simple Levenshtein distance — no npm dependency. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ═══════════════════════════════════════════════════════════════════════
// DELEGATE VALIDATORS (H-11, H-12, SV-04, SV-05)
// ═══════════════════════════════════════════════════════════════════════

/** H-11, H-12: Delegate contract validation. */
export function validateDelegateContracts(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const delegates = agent.coordination?.delegates ?? [];
    for (const delegate of delegates) {
      const target = ctx.agents[delegate.agent];
      if (!target) continue;

      // H-11: Target has no COMPLETION
      if ((target.completion?.conditions?.length ?? 0) === 0) {
        findings.push({
          code: 'H-11',
          message: `Agent "${name}" delegates to "${delegate.agent}" which has no COMPLETION conditions — may never return`,
          severity: 'warning',
          category: 'delegation',
          agentName: name,
          path: `coordination.delegates[agent=${delegate.agent}]`,
        });
      }

      // H-12: Input field doesn't match target GATHER
      const targetGatherNames = new Set((target.gather?.fields ?? []).map((f) => f.name));
      if (delegate.input && targetGatherNames.size > 0) {
        for (const inputField of Object.keys(delegate.input)) {
          if (!targetGatherNames.has(inputField)) {
            findings.push({
              code: 'H-12',
              message: `Agent "${name}" delegate input "${inputField}" does not match any GATHER field in "${delegate.agent}"`,
              severity: 'error',
              category: 'delegation',
              agentName: name,
              path: `coordination.delegates[agent=${delegate.agent}].input`,
            });
          }
        }
      }
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// GUARDRAIL VALIDATORS (GR-01 through GR-05)
// ═══════════════════════════════════════════════════════════════════════

/** GR-01 through GR-05: Guardrail configuration quality. */
export function validateGuardrailConfig(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const guardrails = agent.constraints?.guardrails ?? [];

    // GR-01: No guardrails on agent with tools or gather (customer-facing)
    const hasTools = (agent.tools?.length ?? 0) > 0;
    const hasGather = (agent.gather?.fields?.length ?? 0) > 0;
    if (guardrails.length === 0 && (hasTools || hasGather)) {
      findings.push({
        code: 'GR-01',
        message: `Agent "${name}" has tools/gather but no guardrails — no safety layer for user input`,
        severity: 'warning',
        category: 'guardrail',
        agentName: name,
      });
    }

    for (const guardrail of guardrails) {
      // GR-04: Threshold at extremes
      if (guardrail.threshold === 0 || guardrail.threshold === 1) {
        findings.push({
          code: 'GR-04',
          message: `Agent "${name}" guardrail "${guardrail.name}" has threshold=${guardrail.threshold} — effectively disabled`,
          severity: 'warning',
          category: 'guardrail',
          agentName: name,
          path: `constraints.guardrails[${guardrail.name}]`,
        });
      }
    }
  }
  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// QUALITY FLOOR VALIDATOR (QG-01 through QG-05)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validates minimum quality floor for production readiness.
 * Checks: guardrails, tool-less specialists (informational), session memory,
 * catch-all handoff on supervisors, SUPERVISOR keyword for routers.
 */
export function validateQualityFloor(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];
  const agentEntries = Object.entries(ctx.agents);

  // Use the entry agent from compiler context first, fall back to heuristic.
  // Previous heuristic only checked routing.rules which misses HANDOFF-based
  // supervisors (compiled to coordination.handoffs, not routing.rules),
  // causing the wrong agent to be flagged as entry.
  const entryAgentName =
    ctx.entryAgent ??
    agentEntries.find(([, ir]) => ir.routing?.rules && ir.routing.rules.length > 0)?.[0] ??
    agentEntries.find(([, ir]) => (ir.coordination?.handoffs?.length ?? 0) >= 2)?.[0] ??
    agentEntries[0]?.[0];

  for (const [name, agent] of agentEntries) {
    const hasRouting = agent.routing?.rules && agent.routing.rules.length > 0;

    // QG-01: Missing guardrails
    const guardrails = agent.constraints?.guardrails ?? [];
    if (guardrails.length === 0) {
      findings.push({
        code: 'QG-01',
        message: `Agent "${name}" has no GUARDRAILS — add at minimum content_safety (input, tier 1)`,
        severity: 'warning',
        category: 'guardrail',
        agentName: name,
        path: 'guardrails',
        fix: {
          description: 'Add GUARDRAILS section with content_safety',
          effort: 'S',
        },
      });
    }

    // QG-02: Specialist missing tools
    if (!hasRouting && (!agent.tools || agent.tools.length === 0)) {
      findings.push({
        code: 'QG-02',
        message: `Specialist "${name}" has no TOOLS — acceptable during onboarding if it can gather, reason, or hand off without integrations, but add real project tools later if it must take actions`,
        severity: 'info',
        category: 'tool',
        agentName: name,
        path: 'tools',
        fix: {
          description:
            'Add real project tools only if the agent needs external actions or data retrieval',
          effort: 'S',
        },
      });
    }

    // QG-03: Missing session memory
    if (!agent.memory?.session || agent.memory.session.length === 0) {
      findings.push({
        code: 'QG-03',
        message: `Agent "${name}" has no session MEMORY — add at minimum one tracked variable`,
        severity: 'warning',
        category: 'memory',
        agentName: name,
        path: 'memory.session',
        fix: {
          description: 'Add MEMORY section with session variables',
          effort: 'S',
        },
      });
    }

    // QG-04: Supervisor missing catch-all handoff
    // Only applies to SUPERVISOR: agents (metadata.type === 'supervisor').
    // AGENT: types with escalation handoffs compile to routing.rules but are NOT
    // supervisors — they complete via COMPLETE, not routing. A catch-all on them
    // would break their intended flow.
    if (hasRouting && agent.metadata.type === 'supervisor') {
      const rules = agent.routing?.rules ?? [];
      const hasCatchAll = rules.some(
        (r) => r.when === 'true' || r.when === '"true"' || r.when === "'true'",
      );
      if (!hasCatchAll) {
        findings.push({
          code: 'QG-04',
          message: `Supervisor "${name}" missing catch-all HANDOFF (WHEN: true) — unmatched intents have no fallback`,
          severity: 'warning',
          category: 'handoff',
          agentName: name,
          path: 'routing.rules',
          fix: {
            description: 'Add a final HANDOFF rule with WHEN: true',
            effort: 'S',
          },
        });
      }
    }

    // QG-05: Entry/routing agent should be SUPERVISOR
    if (name === entryAgentName && hasRouting && agent.metadata.type !== 'supervisor') {
      findings.push({
        code: 'QG-05',
        message: `Entry agent "${name}" uses AGENT: but should use SUPERVISOR: for correct routing behavior`,
        severity: 'error',
        category: 'routing',
        agentName: name,
        path: 'type',
        fix: {
          description: 'Change AGENT: to SUPERVISOR: in the DSL',
          effort: 'S',
        },
      });
    }

    // Note: specialist agents CAN have multiple handoffs (escalation, delegation)
    // without being supervisors. Only the entry/routing agent needs SUPERVISOR:.
    // The previous QG-05 expansion flagged any agent with 2+ handoffs as needing
    // SUPERVISOR:, which is incorrect — removed to avoid false positives.
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════════════
// ALL VALIDATORS — exported list for the diagnostic engine
// ═══════════════════════════════════════════════════════════════════════

/** All Tier 2 semantic validators. */
export const ALL_VALIDATORS: ReadonlyArray<{
  name: string;
  fn: (ctx: ValidatorContext) => Finding[];
}> = [
  { name: 'handoffReturnContract', fn: validateHandoffReturnContract },
  { name: 'passFieldExistence', fn: validatePassFieldExistence },
  { name: 'handoffReturnMappings', fn: validateHandoffReturnMappings },
  { name: 'handoffConditionVariables', fn: validateHandoffConditionVariables },
  { name: 'handoffSummaryCoverage', fn: validateHandoffSummaryCoverage },
  { name: 'returnStateCoverage', fn: validateReturnStateCoverage },
  { name: 'routingConflicts', fn: validateRoutingConflicts },
  { name: 'completionReachability', fn: validateCompletionReachability },
  { name: 'toolConfig', fn: validateToolConfig },
  { name: 'gatherQuality', fn: validateGatherQuality },
  { name: 'constraintSemantics', fn: validateConstraintSemantics },
  { name: 'gatherCompleteness', fn: validateGatherCompleteness },
  { name: 'agentIdentity', fn: validateAgentIdentity },
  { name: 'agentNaming', fn: validateAgentNaming },
  { name: 'delegateContracts', fn: validateDelegateContracts },
  { name: 'guardrailConfig', fn: validateGuardrailConfig },
  { name: 'qualityFloor', fn: validateQualityFloor },
  { name: 'flowSemantics', fn: validateFlowSemantics },
  { name: 'memorySemantics', fn: validateMemorySemantics },
  { name: 'behaviorProfiles', fn: validateBehaviorProfiles },
];
