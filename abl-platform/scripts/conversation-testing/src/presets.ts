/**
 * Behavioral presets for conversation scenario generation.
 *
 * Each preset is a prose prompt fragment that describes how the simulated
 * user persona should behave. Presets are domain-agnostic — they describe
 * conversation _shape_ (mood, length, outcome) independent of topic.
 */

import type { PresetName } from './types.js';

/** All valid preset names. */
export const PRESET_NAMES: PresetName[] = [
  'auto',
  'balanced',
  'stress-negative',
  'short-simple',
  'long-complex',
  'abandonment',
];

/** The default preset when none is specified. */
export const DEFAULT_PRESET: PresetName = 'auto';

/** Prose prompt fragments keyed by preset name. */
export const PRESETS: Record<PresetName, string> = {
  auto:
    'Distribute the generated scenarios across a MIX of the following behavioral profiles. ' +
    'Aim for roughly equal coverage across all five profiles so downstream pipelines see diverse signal:\n\n' +
    '1. BALANCED — friendly/neutral/mildly-frustrated mix, 3-8 turns, mixed outcomes.\n' +
    '2. STRESS-NEGATIVE — frustrated/angry/impatient personas, short curt sentences, escalation requests, partial resolution or abandonment.\n' +
    '3. SHORT-SIMPLE — 2-3 turns, single-intent, task-oriented, no small talk, end quickly once answered.\n' +
    '4. LONG-COMPLEX — 6-10 turns, multi-step/multi-intent, gradual context reveal, clarifications, topic pivots.\n' +
    '5. ABANDONMENT — ~70% abandon before resolution (patience loss, channel switch, distraction, dissatisfaction).\n\n' +
    'For each scenario, pick ONE profile and make the persona/goal/behavior/endCondition fields consistent with it. ' +
    'Spread the chosen profiles across the batch — do not cluster all stress-negative scenarios together.',

  balanced:
    'Generate a mix of conversation styles: some friendly, some neutral, some mildly frustrated. ' +
    'Vary conversation lengths between 3 and 8 user turns. Mix outcomes between full resolution, ' +
    'partial resolution, and natural conversation endings. Aim for realistic variety that exercises ' +
    'sentiment, intent classification, and quality evaluation pipelines broadly.',

  'stress-negative':
    'Generate conversations where roughly 80% of personas are frustrated, angry, or impatient. ' +
    'Use short, curt sentences with urgency markers ("this is unacceptable", "I need this fixed NOW"). ' +
    'Include escalation requests ("let me speak to a manager", "I want to file a complaint"). ' +
    'Outcomes should skew toward partial resolution and abandonment. ' +
    'This preset is designed to stress-test negative sentiment detection and friction pipelines.',

  'short-simple':
    'Generate short, focused conversations of 2-3 user turns maximum. Each persona has a single, ' +
    'concrete question or request. Personas are task-oriented and direct — no small talk, no ' +
    'multi-step requests. Conversations end quickly once the answer is provided or the task is done.',

  'long-complex':
    'Generate longer conversations of 6-10 user turns. Personas have multi-step or multi-intent ' +
    'requests. They reveal context gradually — starting with a vague question and adding details ' +
    'as the conversation progresses. Include follow-up questions, clarifications, and topic pivots ' +
    'within a single conversation. This preset exercises multi-turn context tracking and complex ' +
    'intent classification.',

  abandonment:
    'Generate conversations where roughly 70% of personas abandon the conversation before resolution. ' +
    'Reasons include: losing patience with slow responses, deciding to try a different channel, ' +
    'getting distracted and not responding, changing their mind about needing help, or expressing ' +
    'dissatisfaction and leaving. Some personas should announce their departure, others should just ' +
    'stop responding after 2-3 turns. This preset exercises abandonment detection and friction scoring.',
};
