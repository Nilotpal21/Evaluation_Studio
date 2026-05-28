/**
 * BEHAVIOR_PROFILE semantic validators — BP-01 through BP-06.
 *
 * Pure functions operating on compiled AgentIR. No I/O, no side effects.
 *
 * Source IR types: BehaviorProfileIR, GatherProfileOverrides,
 * FlowModificationsIR from @abl/compiler schema.ts
 *
 * Bounded collections: all local to function calls, bounded by agent
 * profile/field/tool counts (typically <20 items each).
 */

import type { Finding, ValidatorContext } from './types.js';

/** Defensive bound for local collections. */
const MAX_TRACKED = 200;

/**
 * Validates BEHAVIOR_PROFILE semantics across all agents.
 * Emits: BP-02, BP-03, BP-04, BP-05, BP-06.
 *
 * BP-01 (WHEN references undeclared variable) is deferred — requires
 * cross-construct variable resolution that depends on session state shape.
 */
export function validateBehaviorProfiles(ctx: ValidatorContext): Finding[] {
  const findings: Finding[] = [];

  for (const [name, agent] of Object.entries(ctx.agents)) {
    const profiles = agent.behavior_profiles;
    if (!profiles || profiles.length === 0) continue;

    const agentToolNames = new Set((agent.tools ?? []).slice(0, MAX_TRACKED).map((t) => t.name));
    const gatherFieldNames = new Set(
      (agent.gather?.fields ?? []).slice(0, MAX_TRACKED).map((f) => f.name),
    );
    const flowStepNames = new Set(Object.keys(agent.flow?.definitions ?? {}).slice(0, MAX_TRACKED));

    // BP-02: Multiple profiles with same priority
    const priorityMap = new Map<number, string[]>();
    for (const profile of profiles) {
      const existing = priorityMap.get(profile.priority) ?? [];
      existing.push(profile.name);
      priorityMap.set(profile.priority, existing);
    }
    if (priorityMap.size > MAX_TRACKED) priorityMap.clear();

    for (const [priority, names] of priorityMap) {
      if (names.length > 1) {
        findings.push({
          code: 'BP-02',
          message: `Agent "${name}" has ${names.length} behavior profiles with priority ${priority}: ${names.join(', ')} — non-deterministic selection`,
          severity: 'warning',
          category: 'behavior-profile',
          agentName: name,
        });
      }
    }

    for (const profile of profiles) {
      // BP-03: Profile hides tool required by flow
      if (profile.tools_hide && agent.flow?.definitions) {
        for (const hiddenTool of profile.tools_hide) {
          // Check if any flow step CALLs this tool
          for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
            if (step.call) {
              const toolRef = step.call.split('(')[0].trim();
              if (toolRef === hiddenTool) {
                findings.push({
                  code: 'BP-03',
                  message: `Agent "${name}" profile "${profile.name}" hides tool "${hiddenTool}" but flow step "${stepName}" requires it via CALL`,
                  severity: 'error',
                  category: 'behavior-profile',
                  agentName: name,
                  path: `behavior_profiles[${profile.name}].tools_hide`,
                });
              }
            }
          }
        }
      }

      // BP-04: Profile adds tool not in agent declaration (no binding)
      if (profile.tools_add) {
        for (const addedTool of profile.tools_add) {
          // tools_add includes full tool definitions, so they're self-contained
          // However, check that the tool name doesn't collide with an existing tool
          if (agentToolNames.has(addedTool.name)) {
            findings.push({
              code: 'BP-04',
              message: `Agent "${name}" profile "${profile.name}" adds tool "${addedTool.name}" which already exists in the agent's TOOLS — may cause conflict`,
              severity: 'warning',
              category: 'behavior-profile',
              agentName: name,
              path: `behavior_profiles[${profile.name}].tools_add`,
            });
          }
        }
      }

      // BP-05: gather_overrides targets non-existent field
      if (profile.gather_overrides?.field_overrides) {
        for (const fieldName of Object.keys(profile.gather_overrides.field_overrides)) {
          if (gatherFieldNames.size > 0 && !gatherFieldNames.has(fieldName)) {
            findings.push({
              code: 'BP-05',
              message: `Agent "${name}" profile "${profile.name}" overrides gather field "${fieldName}" which does not exist in GATHER`,
              severity: 'warning',
              category: 'behavior-profile',
              agentName: name,
              path: `behavior_profiles[${profile.name}].gather_overrides.field_overrides.${fieldName}`,
            });
          }
        }
      }

      // BP-05 extended: flow_modifications.skip targets non-existent step
      if (profile.flow_modifications?.skip) {
        for (const stepName of profile.flow_modifications.skip) {
          if (flowStepNames.size > 0 && !flowStepNames.has(stepName)) {
            findings.push({
              code: 'BP-05',
              message: `Agent "${name}" profile "${profile.name}" skips flow step "${stepName}" which does not exist in FLOW`,
              severity: 'warning',
              category: 'behavior-profile',
              agentName: name,
              path: `behavior_profiles[${profile.name}].flow_modifications.skip`,
            });
          }
        }
      }
    }

    // BP-06: No default profile (no profile without a WHEN condition)
    const hasDefault = profiles.some((p) => !p.when || p.when.trim() === '' || p.when === 'true');
    if (!hasDefault && profiles.length > 1) {
      findings.push({
        code: 'BP-06',
        message: `Agent "${name}" has ${profiles.length} behavior profiles but no default profile (no WHEN: true or empty WHEN) — behavior undefined when no profile matches`,
        severity: 'info',
        category: 'behavior-profile',
        agentName: name,
      });
    }
  }

  return findings;
}
