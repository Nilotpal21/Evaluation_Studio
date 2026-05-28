/**
 * Assembler — pure function that combines a skeleton + validated creative
 * content into the final ABL YAML string plus a slot-to-line map.
 *
 * Deterministic. Zero LLM. Uses manual emission rather than yaml.stringify
 * because ABL's opinionated UPPERCASE keyword style (SUPERVISOR:, GOAL:,
 * HANDOFF:) does not round-trip cleanly through standard YAML libraries.
 *
 * The slot map records the line range each creative slot occupies in the
 * assembled YAML. Used by the fix-loop's Ring 3 to trace compile errors
 * back to individual slots for targeted re-prompting.
 */

import { renderDefaultContentSafetyGuardrail } from '@agent-platform/arch-ai/guardrails';
import { deriveScaffoldRuntimePlan, stateNameFromResultField } from './runtime-flow';
import type { AblSkeleton, CreativeContent, SlotMap } from './types';

export function assembleAblAgent(
  skeleton: AblSkeleton,
  creative: CreativeContent,
): { yaml: string; slotMap: SlotMap } {
  const lines: string[] = [];
  const slotMap: SlotMap = new Map();

  const pushLine = (line: string): number => {
    lines.push(line);
    return lines.length;
  };

  // ─── Header ────────────────────────────────────────────────────────────
  pushLine(`${skeleton.keyword}: ${skeleton.agentName}`);

  // ─── GOAL ──────────────────────────────────────────────────────────────
  const goal = requireSlot(creative, skeleton.goalSlot);
  const goalLine = pushLine(`GOAL: "${escapeYamlDouble(goal)}"`);
  slotMap.set(skeleton.goalSlot, { lineStart: goalLine, lineEnd: goalLine });

  // ─── PERSONA (literal block) ───────────────────────────────────────────
  const persona = requireSlot(creative, skeleton.personaSlot);
  pushLine('PERSONA: |');
  const personaStart = lines.length + 1;
  for (const ln of persona.split('\n')) {
    pushLine(`  ${ln}`);
  }
  slotMap.set(skeleton.personaSlot, {
    lineStart: personaStart,
    lineEnd: lines.length,
  });

  if ((skeleton.behaviorProfileUses ?? []).length > 0) {
    for (const profileName of skeleton.behaviorProfileUses ?? []) {
      pushLine('');
      pushLine(`USE BEHAVIOR_PROFILE: ${profileName}`);
    }
  }

  // ─── ON_START welcome (entry agent only) ───────────────────────────────
  if (skeleton.onStartRespond) {
    pushLine('');
    pushLine('ON_START:');
    pushLine(`  RESPOND: "${escapeYamlDouble(skeleton.onStartRespond)}"`);
  }

  // ─── HANDOFF ───────────────────────────────────────────────────────────
  if (skeleton.handoffs.length > 0) {
    pushLine('');
    pushLine('HANDOFF:');
    for (const handoff of skeleton.handoffs) {
      pushLine(`  - TO: ${handoff.to}`);
      let whenValue: string;
      if (handoff.whenSlot === null) {
        whenValue = handoff.whenLiteral ?? 'true';
      } else {
        whenValue = normalizeHandoffWhen(requireSlot(creative, handoff.whenSlot), {
          declaredMemoryVars: skeleton.memorySessionVars,
        });
        const whenLine = lines.length + 1;
        slotMap.set(handoff.whenSlot, { lineStart: whenLine, lineEnd: whenLine });
      }
      pushLine(`    WHEN: ${renderCondition(whenValue)}`);
      if (handoff.experienceMode) {
        pushLine(`    EXPERIENCE_MODE: ${handoff.experienceMode}`);
      }
      pushLine(`    RETURN: ${handoff.returnExpected ? 'true' : 'false'}`);
    }
  }

  // ─── TOOLS ─────────────────────────────────────────────────────────────
  if (skeleton.tools.length > 0) {
    pushLine('');
    pushLine('TOOLS:');
    for (const tool of skeleton.tools) {
      pushLine(`  ${tool.signatureLiteral}`);
      pushLine(`    description: "${escapeYamlDouble(tool.descriptionLiteral)}"`);
      pushLine(`    side_effects: ${tool.sideEffects ? 'true' : 'false'}`);
      const paramDescriptionEntries = Object.entries(tool.paramDescriptions);
      if (paramDescriptionEntries.length > 0) {
        pushLine('    parameters:');
        for (const [paramName, description] of paramDescriptionEntries) {
          pushLine(`      ${paramName}:`);
          pushLine(`        description: "${escapeYamlDouble(description)}"`);
        }
      }
      pushLine(`    confirm: ${tool.confirmPolicy}`);
    }
  }

  // ─── GATHER (slice 2+) ─────────────────────────────────────────────────
  if (skeleton.gatherFields.length > 0) {
    pushLine('');
    pushLine('GATHER:');
    for (const field of skeleton.gatherFields) {
      pushLine(`  ${field.name}:`);
      pushLine(`    type: ${field.type}`);
      pushLine(`    required: true`);
      const askValue = requireSlot(creative, field.askSlot);
      const askLine = pushLine(`    prompt: "${escapeYamlDouble(askValue)}"`);
      slotMap.set(field.askSlot, { lineStart: askLine, lineEnd: askLine });
    }
  }

  // ─── FLOW ─────────────────────────────────────────────────────────────
  const runtimePlan = deriveScaffoldRuntimePlan(skeleton);
  if (runtimePlan.flow.length > 0) {
    pushLine('');
    pushLine('FLOW:');
    pushLine('  steps:');
    for (const step of runtimePlan.flow) {
      pushLine(`    - ${step.name}`);
    }

    const toolCallByStep = new Map(runtimePlan.toolCalls.map((call) => [call.step, call]));
    for (const step of runtimePlan.flow) {
      pushLine(`  ${step.name}:`);
      pushLine(`    REASONING: ${step.reasoning ? 'true' : 'false'}`);
      if (step.respond) {
        pushLine(`    RESPOND: "${escapeYamlDouble(step.respond)}"`);
      }
      const call = step.call ? toolCallByStep.get(step.name) : undefined;
      if (call) {
        pushLine(`    CALL: ${call.tool}`);
        const withEntries = Object.entries(call.with);
        if (withEntries.length > 0) {
          pushLine('      WITH:');
          for (const [arg, expression] of withEntries) {
            pushLine(`        ${arg}: ${expression}`);
          }
        }
        pushLine(`      AS: ${call.as}`);
        const setEntries = Object.entries(step.set ?? {});
        if (setEntries.length > 0) {
          pushLine('    ON_RESULT:');
          pushLine('      - ELSE:');
          for (const [field, expression] of setEntries) {
            pushLine(`        SET: ${field} = ${expression}`);
          }
          if (step.then) {
            pushLine(`        THEN: ${step.then}`);
          }
        } else if (step.then) {
          pushLine('    ON_SUCCESS:');
          pushLine(`      THEN: ${step.then}`);
        }
        pushLine('    ON_FAILURE:');
        if (call.onFailure.respond) {
          pushLine(`      RESPOND: "${escapeYamlDouble(call.onFailure.respond)}"`);
        }
        pushLine(`      THEN: ${call.onFailure.then}`);
        continue;
      }
      if (step.complete) {
        pushLine('    THEN: COMPLETE');
      } else if (step.then) {
        pushLine(`    THEN: ${step.then === 'COMPLETE' ? 'COMPLETE' : step.then}`);
      }
    }
  }

  // ─── COMPLETE (slice 2+) ───────────────────────────────────────────────
  if (skeleton.completeSlots.length > 0) {
    pushLine('');
    pushLine('COMPLETE:');
    for (const pair of skeleton.completeSlots) {
      const whenValue =
        pair.whenSlot === null
          ? requireLiteral(pair.whenLiteral, 'COMPLETE WHEN')
          : requireSlot(creative, pair.whenSlot);
      const respondValue =
        pair.respondSlot === null
          ? requireLiteral(pair.respondLiteral, 'COMPLETE RESPOND')
          : requireSlot(creative, pair.respondSlot);
      const whenLine = pushLine(`  - WHEN: ${renderCondition(whenValue)}`);
      const respondLine = pushLine(`    RESPOND: "${escapeYamlDouble(respondValue)}"`);
      if (pair.whenSlot !== null) {
        slotMap.set(pair.whenSlot, { lineStart: whenLine, lineEnd: whenLine });
      }
      if (pair.respondSlot !== null) {
        slotMap.set(pair.respondSlot, { lineStart: respondLine, lineEnd: respondLine });
      }
    }
  }

  // ─── GUARDRAILS ────────────────────────────────────────────────────────
  if (skeleton.includeGuardrails) {
    pushLine('');
    for (const line of renderDefaultContentSafetyGuardrail().split('\n')) {
      pushLine(line);
    }
  }

  // ─── MEMORY ────────────────────────────────────────────────────────────
  if (skeleton.memorySessionVars.length > 0) {
    pushLine('');
    pushLine('MEMORY:');
    pushLine('  session:');
    for (const varName of skeleton.memorySessionVars) {
      pushLine(`    - name: ${varName}`);
      pushLine(`      type: string`);
      pushLine(`      initial_value: null`);
    }
  }

  return { yaml: lines.join('\n') + '\n', slotMap };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireSlot(creative: CreativeContent, slotPath: string): string {
  const value = creative[slotPath];
  if (typeof value !== 'string') {
    throw new Error(`assembleAblAgent: missing creative content for slot "${slotPath}"`);
  }
  return value;
}

function requireLiteral(value: string | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`assembleAblAgent: missing code-owned literal for ${label}`);
  }
  return value;
}

function renderCondition(value: string): string {
  const trimmed = value.trim();
  return (trimmed.length > 0 ? trimmed : 'true').replace(/\r?\n/g, ' ');
}

function escapeYamlDouble(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function normalizeHandoffWhen(
  value: string,
  options: { declaredMemoryVars: ReadonlyArray<string> },
): string {
  const trimmed = value.trim();
  if (!hasBalancedQuotes(trimmed)) {
    return withRouterGatherGuard('intent.category == "general"', options.declaredMemoryVars);
  }

  let normalized: string;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    normalized = `intent.category == "${trimmed}"`;
  } else {
    const roots = collectConditionRoots(trimmed);
    const declared = new Set(options.declaredMemoryVars);
    const inventedRoots = roots.filter((root) => root !== 'intent' && !declared.has(root));
    if (inventedRoots.length > 0) {
      normalized = `intent.category == "${deriveIntentCategory(trimmed, inventedRoots)}"`;
    } else {
      normalized = trimmed;
    }
  }

  return withRouterGatherGuard(normalized, options.declaredMemoryVars);
}

const CONDITION_RESERVED_ROOTS = new Set([
  'AND',
  'OR',
  'NOT',
  'and',
  'or',
  'not',
  'true',
  'false',
  'null',
]);

function collectConditionRoots(value: string): string[] {
  const withoutStrings = value.replace(/"[^"]*"|'[^']*'/g, ' ');
  const matches = withoutStrings.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const match of matches) {
    const root = match.split('.')[0];
    if (CONDITION_RESERVED_ROOTS.has(root) || seen.has(root)) {
      continue;
    }
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function hasBalancedQuotes(value: string): boolean {
  const doubleQuoteCount = (value.match(/"/g) ?? []).length;
  const singleQuoteCount = (value.match(/'/g) ?? []).length;
  return doubleQuoteCount % 2 === 0 && singleQuoteCount % 2 === 0;
}

function withRouterGatherGuard(
  condition: string,
  declaredMemoryVars: ReadonlyArray<string>,
): string {
  if (!declaredMemoryVars.includes('routing_intent')) {
    return condition;
  }

  if (collectConditionRoots(condition).includes('routing_intent')) {
    return condition;
  }

  const trimmed = condition.trim();
  if (trimmed === 'true') {
    return 'routing_intent != null';
  }

  return `routing_intent != null AND (${trimmed})`;
}

function deriveIntentCategory(value: string, inventedRoots: ReadonlyArray<string>): string {
  const quotedLiteral = value.match(/["']([a-zA-Z0-9_ -]{3,80})["']/)?.[1];
  const seed = quotedLiteral ?? inventedRoots[0] ?? value;
  const normalized = seed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

  return normalized.length > 0 ? normalized : 'general';
}
