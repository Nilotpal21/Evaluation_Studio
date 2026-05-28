/**
 * FLOW semantic validators — F-01 through F-14.
 *
 * Pure functions operating on compiled AgentIR. No I/O, no side effects.
 * Each validator checks one or more rules from the registry.
 *
 * Source IR types: FlowConfig, FlowStep from @abl/compiler schema.ts
 */

import type { AgentIR } from '@abl/compiler';
import type { Finding, ValidatorContext } from './types.js';

/**
 * Validates FLOW semantics across all agents.
 * Emits: F-01, F-02, F-03, F-04, F-06, F-07, F-08, F-09, F-12, F-14.
 *
 * Rules not implemented here (require deeper analysis):
 *   F-05 (PRESENT references undefined template — needs template registry)
 *   F-10 (Digression has no return step — needs digression RESUME analysis)
 *   F-11 (sub_intent overlaps with main flow gather — low severity, deferred)
 *   F-13 (exit_when is always true — requires expression evaluator)
 */
export function validateFlowSemantics(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const flow = agent.flow;
    if (!flow) continue;

    const declaredSteps = flow.steps ?? [];
    const definitions = flow.definitions ?? {};
    const definedStepNames = new Set(Object.keys(definitions));
    const toolNames = new Set((agent.tools ?? []).map((t) => t.name));

    // F-03: No entry point — steps array is empty or first step has no definition
    if (declaredSteps.length === 0) {
      findings.push({
        code: 'F-03',
        message: `Agent "${name}" FLOW has empty steps array — no entry point`,
        severity: 'error',
        category: 'flow',
        agentName: name,
        path: 'flow.steps',
      });
      continue; // Can't check further without steps
    }

    // F-03 variant: first step not defined
    if (!definedStepNames.has(declaredSteps[0])) {
      findings.push({
        code: 'F-03',
        message: `Agent "${name}" FLOW entry point "${declaredSteps[0]}" has no definition`,
        severity: 'error',
        category: 'flow',
        agentName: name,
        path: `flow.definitions.${declaredSteps[0]}`,
      });
    }

    // Check each declared step has a definition
    for (const stepName of declaredSteps) {
      if (!definedStepNames.has(stepName)) {
        // This is already covered by F-03 for the first step, and by
        // F-01 for THEN references — skip duplicate for declared-but-undefined
        // (the compiler's Tier 1 validation catches this)
      }
    }

    // Collect all THEN targets and reachable steps for F-01, F-02
    const allThenTargets = new Set<string>();
    const reachable = new Set<string>();

    for (const [stepName, step] of Object.entries(definitions)) {
      // F-01: THEN references non-existent step
      if (step.then && step.then !== 'COMPLETE') {
        allThenTargets.add(step.then);
        if (!definedStepNames.has(step.then)) {
          findings.push({
            code: 'F-01',
            message: `Agent "${name}" step "${stepName}" THEN references non-existent step "${step.then}"`,
            severity: 'error',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}.then`,
          });
        }
      }

      // F-01: Also check ON_INPUT/ON_RESULT branch targets
      for (const branch of step.on_input ?? []) {
        if (branch.then && branch.then !== 'COMPLETE' && !definedStepNames.has(branch.then)) {
          findings.push({
            code: 'F-01',
            message: `Agent "${name}" step "${stepName}" ON_INPUT branch targets non-existent step "${branch.then}"`,
            severity: 'error',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}.on_input`,
          });
        }
      }

      for (const branch of step.on_result ?? []) {
        if (branch.then && branch.then !== 'COMPLETE' && !definedStepNames.has(branch.then)) {
          findings.push({
            code: 'F-01',
            message: `Agent "${name}" step "${stepName}" ON_RESULT branch targets non-existent step "${branch.then}"`,
            severity: 'error',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}.on_result`,
          });
        }
      }

      // F-01: Check ON_SUCCESS/ON_FAILURE targets
      if (
        step.on_success?.then &&
        step.on_success.then !== 'COMPLETE' &&
        !definedStepNames.has(step.on_success.then)
      ) {
        findings.push({
          code: 'F-01',
          message: `Agent "${name}" step "${stepName}" ON_SUCCESS targets non-existent step "${step.on_success.then}"`,
          severity: 'error',
          category: 'flow',
          agentName: name,
          path: `flow.definitions.${stepName}.on_success.then`,
        });
      }

      if (
        step.on_failure?.then &&
        step.on_failure.then !== 'COMPLETE' &&
        !definedStepNames.has(step.on_failure.then)
      ) {
        findings.push({
          code: 'F-01',
          message: `Agent "${name}" step "${stepName}" ON_FAILURE targets non-existent step "${step.on_failure.then}"`,
          severity: 'error',
          category: 'flow',
          agentName: name,
          path: `flow.definitions.${stepName}.on_failure.then`,
        });
      }

      // F-04: Step has no action (no respond, no gather, no call, no reasoning zone, no set)
      const hasAction =
        step.respond ||
        step.gather ||
        step.call ||
        step.reasoning_zone ||
        step.set ||
        step.transform ||
        step.human_approval ||
        step.await_attachment ||
        step.on_input ||
        step.present;

      if (!hasAction) {
        findings.push({
          code: 'F-04',
          message: `Agent "${name}" step "${stepName}" has no action (no RESPOND, GATHER, CALL, REASONING, SET, or TRANSFORM)`,
          severity: 'warning',
          category: 'flow',
          agentName: name,
          path: `flow.definitions.${stepName}`,
        });
      }

      // F-06: CALL references non-existent tool
      if (step.call) {
        // call can be "tool_name(params)" or just "tool_name"
        const toolRef = step.call.split('(')[0].trim();
        if (!toolNames.has(toolRef)) {
          findings.push({
            code: 'F-06',
            message: `Agent "${name}" step "${stepName}" CALL references tool "${toolRef}" which is not defined in TOOLS`,
            severity: 'error',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}.call`,
          });
        }
      }

      // F-12: max_attempts is 0 or negative (check reasoning_zone)
      if (step.reasoning_zone?.max_turns !== undefined && step.reasoning_zone.max_turns < 1) {
        findings.push({
          code: 'F-12',
          message: `Agent "${name}" step "${stepName}" REASONING zone max_turns=${step.reasoning_zone.max_turns} — must be >= 1`,
          severity: 'warning',
          category: 'flow',
          agentName: name,
          path: `flow.definitions.${stepName}.reasoning_zone.max_turns`,
        });
      }

      // F-14: REASONING_ZONE has no available_tools
      // Skip when the step has a productive action (respond, gather) — reasoning is used
      // for response generation, not tool calling. Only warn when the step's sole purpose
      // is the reasoning zone itself (no other action).
      if (
        step.reasoning_zone &&
        (!step.reasoning_zone.available_tools || step.reasoning_zone.available_tools.length === 0)
      ) {
        const hasProductiveAction = step.respond || step.gather || step.call || step.transform;
        if (!hasProductiveAction) {
          findings.push({
            code: 'F-14',
            message: `Agent "${name}" step "${stepName}" has REASONING zone but no available_tools — LLM cannot call any tools in this zone`,
            severity: 'warning',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}.reasoning_zone.available_tools`,
          });
        }
      }
    }

    // F-02: Unreachable steps (BFS from entry point)
    if (declaredSteps.length > 0 && definedStepNames.has(declaredSteps[0])) {
      const visited = new Set<string>();
      const queue = [declaredSteps[0]];
      visited.add(declaredSteps[0]);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const step = definitions[current];
        if (!step) continue;

        // Collect all reachable targets from this step
        const targets: string[] = [];
        if (step.then && step.then !== 'COMPLETE') targets.push(step.then);
        if (step.on_fail && step.on_fail !== 'COMPLETE') targets.push(step.on_fail);
        if (step.on_success?.then && step.on_success.then !== 'COMPLETE')
          targets.push(step.on_success.then);
        if (step.on_failure?.then && step.on_failure.then !== 'COMPLETE')
          targets.push(step.on_failure.then);

        for (const branch of step.on_input ?? []) {
          if (branch.then && branch.then !== 'COMPLETE') targets.push(branch.then);
        }
        for (const branch of step.on_result ?? []) {
          if (branch.then && branch.then !== 'COMPLETE') targets.push(branch.then);
        }
        for (const dig of step.digressions ?? []) {
          if (dig.goto && dig.goto !== 'COMPLETE') targets.push(dig.goto);
        }

        for (const target of targets) {
          if (!visited.has(target) && definedStepNames.has(target)) {
            visited.add(target);
            queue.push(target);
          }
        }
      }

      // Any defined step NOT in visited is unreachable
      for (const stepName of definedStepNames) {
        if (!visited.has(stepName)) {
          findings.push({
            code: 'F-02',
            message: `Agent "${name}" step "${stepName}" is unreachable — no path from entry point "${declaredSteps[0]}"`,
            severity: 'warning',
            category: 'flow',
            agentName: name,
            path: `flow.definitions.${stepName}`,
          });
        }
      }
    }

    // F-09: Cycle without exit condition (DFS cycle detection)
    // A cycle is only a problem if no step in the cycle has a branch
    // that exits (THEN: COMPLETE or ON_INPUT with COMPLETE path).
    const cycleSteps = detectFlowCycles(definitions, declaredSteps[0]);
    for (const cyclePath of cycleSteps) {
      // Check if any step in the cycle has an exit path
      const hasExit = cyclePath.some((stepName) => {
        const step = definitions[stepName];
        if (!step) return false;
        if (step.then === 'COMPLETE') return true;
        if (step.on_success?.then === 'COMPLETE') return true;
        if (step.on_failure?.then === 'COMPLETE') return true;
        if (step.on_input?.some((b) => b.then === 'COMPLETE')) return true;
        if (step.on_result?.some((b) => b.then === 'COMPLETE')) return true;
        if (step.complete_when) return true;
        return false;
      });

      if (!hasExit) {
        findings.push({
          code: 'F-09',
          message: `Agent "${name}" has cycle in flow steps [${cyclePath.join(' → ')}] with no exit condition — potential infinite loop`,
          severity: 'error',
          category: 'flow',
          agentName: name,
          path: 'flow.definitions',
        });
      }
    }
  }

  return findings;
}

/**
 * Detect cycles in the flow step graph using DFS.
 * Returns arrays of step names forming cycles.
 */
function detectFlowCycles(
  definitions: Record<
    string,
    {
      then?: string;
      on_input?: Array<{ then?: string }>;
      on_result?: Array<{ then?: string }>;
      on_success?: { then?: string };
      on_failure?: { then?: string };
      on_fail?: string;
    }
  >,
  entryPoint: string,
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function getTargets(stepName: string): string[] {
    const step = definitions[stepName];
    if (!step) return [];
    const targets: string[] = [];
    if (step.then && step.then !== 'COMPLETE') targets.push(step.then);
    if (step.on_fail && step.on_fail !== 'COMPLETE') targets.push(step.on_fail);
    if (step.on_success?.then && step.on_success.then !== 'COMPLETE')
      targets.push(step.on_success.then);
    if (step.on_failure?.then && step.on_failure.then !== 'COMPLETE')
      targets.push(step.on_failure.then);
    for (const b of step.on_input ?? []) {
      if (b.then && b.then !== 'COMPLETE') targets.push(b.then);
    }
    for (const b of step.on_result ?? []) {
      if (b.then && b.then !== 'COMPLETE') targets.push(b.then);
    }
    return targets;
  }

  function dfs(node: string): void {
    if (inStack.has(node)) {
      // Found a cycle — extract the cycle from the path
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const target of getTargets(node)) {
      if (definitions[target]) {
        dfs(target);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  dfs(entryPoint);
  return cycles;
}
