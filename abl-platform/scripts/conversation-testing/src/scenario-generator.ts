/**
 * Scenario generator — one LLM call produces all N scenarios.
 *
 * Ensures intent diversity across the batch by generating all scenarios
 * in a single prompt rather than per-scenario calls.
 */

import { z } from 'zod';
import { createLogger } from '@agent-platform/shared-observability/logger';
import type { LLMClient, PresetName, RunConfig, Scenario, SlotAssignment } from './types.js';
import { buildScenarioPrompt } from './prompt-builder.js';
import { PRESET_NAMES } from './presets.js';

const log = createLogger('scenario-generator');

/** All presets except the `auto` meta-preset — the pool we sample from for auto mode. */
const AUTO_PRESET_POOL: Exclude<PresetName, 'auto'>[] = PRESET_NAMES.filter(
  (p): p is Exclude<PresetName, 'auto'> => p !== 'auto',
);

/**
 * Build authoritative per-scenario assignments whenever targeting matters.
 *
 * Slot generation is the source of truth for:
 * - `PRESET=auto` runs, where the preset varies per scenario
 * - all-agents runs, where target-agent coverage and total count must be exact
 */
function buildScenarioSlots(config: RunConfig): SlotAssignment[] | undefined {
  const pickPreset = () => AUTO_PRESET_POOL[Math.floor(Math.random() * AUTO_PRESET_POOL.length)];
  const shouldBuildSlots = config.preset === 'auto' || (config.agents?.length ?? 0) > 0;

  if (!shouldBuildSlots) {
    return undefined;
  }

  const pickAssignedPreset = (): Exclude<PresetName, 'auto'> =>
    config.preset === 'auto' ? pickPreset() : config.preset;

  if (config.agents && config.agents.length > 0) {
    const agents = config.agents;
    return Array.from({ length: config.runs }, (_, i) => ({
      preset: pickAssignedPreset(),
      targetAgent: agents[i % agents.length].name,
    }));
  }

  return Array.from({ length: config.runs }, () => ({ preset: pickAssignedPreset() }));
}

const ScenarioSchema = z.object({
  intent: z.string().min(1),
  persona: z.string().min(1),
  goal: z.string().min(1),
  behavior: z.string().min(1),
  endCondition: z.string().min(1),
  targetAgent: z.string().min(1).optional(),
});

const ScenariosArraySchema = z.array(ScenarioSchema).min(1);

/** Strip markdown fences from LLM output if present. */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Parse and validate JSON scenario output from the LLM.
 *
 * @throws Error with code and message if parsing or validation fails.
 */
function parseScenariosJson(raw: string): Scenario[] {
  const cleaned = stripMarkdownFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw Object.assign(new Error('LLM output is not valid JSON'), {
      code: 'INVALID_JSON',
    });
  }

  const result = ScenariosArraySchema.safeParse(parsed);
  if (!result.success) {
    throw Object.assign(new Error(`Scenario validation failed: ${result.error.message}`), {
      code: 'VALIDATION_FAILED',
    });
  }

  return result.data;
}

/**
 * Generate N conversation scenarios via a single LLM call.
 *
 * Retries once on malformed JSON with a stricter instruction appended.
 * Slot-driven runs require exact cardinality so metadata stays trustworthy.
 */
function attachSlotMetadata(scenarios: Scenario[], slots: SlotAssignment[]): Scenario[] {
  if (scenarios.length !== slots.length) {
    throw Object.assign(
      new Error(
        `Expected exactly ${slots.length} scenarios for slot-driven generation, received ${scenarios.length}`,
      ),
      { code: 'SLOT_COUNT_MISMATCH' },
    );
  }

  return scenarios.map((s, i) => {
    const slot = slots[i];
    if (!slot) {
      throw Object.assign(new Error(`Missing slot assignment for scenario ${i + 1}`), {
        code: 'SLOT_ASSIGNMENT_MISSING',
      });
    }
    if (s.targetAgent && slot.targetAgent && s.targetAgent !== slot.targetAgent) {
      throw Object.assign(
        new Error(
          `Scenario ${i + 1} targeted "${s.targetAgent}" but slot assignment requires "${slot.targetAgent}"`,
        ),
        { code: 'SLOT_TARGET_MISMATCH' },
      );
    }

    return {
      ...s,
      assignedPreset: slot.preset,
      ...(slot.targetAgent ? { targetAgent: slot.targetAgent } : {}),
    };
  });
}

export async function generateScenarios(llm: LLMClient, config: RunConfig): Promise<Scenario[]> {
  const slots = buildScenarioSlots(config);
  const systemPrompt = buildScenarioPrompt(config, slots);

  log.info('Generating scenarios', {
    runs: config.runs,
    preset: config.preset,
    agentCount: config.agents?.length ?? 0,
    runsPerAgent: config.runsPerAgent,
    slotCount: slots?.length ?? 0,
  });

  let raw: string;
  try {
    raw = await llm.chat([{ role: 'user', content: 'Generate the scenarios now.' }], systemPrompt);
  } catch (err) {
    throw Object.assign(
      new Error(
        `LLM call failed during scenario generation: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { code: 'LLM_ERROR' },
    );
  }

  try {
    let scenarios = parseScenariosJson(raw);
    if (!slots && scenarios.length < config.runs) {
      log.warn('Fewer scenarios than requested', {
        requested: config.runs,
        received: scenarios.length,
      });
    }
    if (slots) {
      scenarios = attachSlotMetadata(scenarios, slots);
    }
    log.info('Scenarios generated successfully', { count: scenarios.length });
    return scenarios;
  } catch (firstErr) {
    const errorCode =
      typeof firstErr === 'object' && firstErr && 'code' in firstErr ? firstErr.code : undefined;
    if (
      errorCode === 'SLOT_COUNT_MISMATCH' ||
      errorCode === 'SLOT_TARGET_MISMATCH' ||
      errorCode === 'SLOT_ASSIGNMENT_MISSING'
    ) {
      throw firstErr;
    }

    log.warn('First scenario parse failed, retrying with stricter instruction', {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });

    // Retry once with stricter instruction
    const stricterPrompt = systemPrompt + '\n\nReply with JSON only, no markdown fences, no prose.';

    let retryRaw: string;
    try {
      retryRaw = await llm.chat(
        [{ role: 'user', content: 'Generate the scenarios now.' }],
        stricterPrompt,
      );
    } catch (err) {
      throw Object.assign(
        new Error(`LLM retry call failed: ${err instanceof Error ? err.message : String(err)}`),
        { code: 'LLM_ERROR' },
      );
    }

    let scenarios = parseScenariosJson(retryRaw);
    if (scenarios.length === 0) {
      throw Object.assign(new Error('Zero scenarios returned after retry'), {
        code: 'NO_SCENARIOS',
      });
    }
    if (!slots && scenarios.length < config.runs) {
      log.warn('Fewer scenarios than requested after retry', {
        requested: config.runs,
        received: scenarios.length,
      });
    }
    if (slots) {
      scenarios = attachSlotMetadata(scenarios, slots);
    }
    log.info('Scenarios generated on retry', { count: scenarios.length });
    return scenarios;
  }
}
