const VALID_COMMUNICATION_STYLES = ['casual', 'formal', 'technical', 'terse', 'verbose'] as const;
const VALID_DOMAIN_KNOWLEDGE = ['beginner', 'intermediate', 'expert'] as const;
const VALID_ADVERSARIAL_TYPES = [
  'prompt_injection',
  'social_engineering',
  'off_topic',
  'abusive',
  'edge_case',
] as const;
const VALID_SCENARIO_CATEGORIES = [
  'happy_path',
  'edge_case',
  'error_handling',
  'multi_turn',
  'handoff',
  'adversarial',
] as const;
const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

type StringLiteral<T extends readonly string[]> = T[number];

export interface NormalizedGeneratedPersona {
  name: string;
  description: string;
  communicationStyle: StringLiteral<typeof VALID_COMMUNICATION_STYLES>;
  domainKnowledge: StringLiteral<typeof VALID_DOMAIN_KNOWLEDGE>;
  behaviorTraits: string[];
  goals: string;
  constraints: string;
  isAdversarial: boolean;
  adversarialType?: StringLiteral<typeof VALID_ADVERSARIAL_TYPES>;
}

export interface NormalizedGeneratedScenario {
  name: string;
  description: string;
  category: StringLiteral<typeof VALID_SCENARIO_CATEGORIES>;
  difficulty: StringLiteral<typeof VALID_DIFFICULTIES>;
  entryAgent?: string;
  initialMessage: string;
  expectedOutcome: string;
  maxTurns: number;
  expectedMilestones: string[];
  agentPath: string[];
  tags: string[];
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(cleanString)
    .filter((item): item is string => item !== undefined)
    .slice(0, maxItems);
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: StringLiteral<T>,
): StringLiteral<T> {
  return typeof value === 'string' && allowed.includes(value as StringLiteral<T>)
    ? (value as StringLiteral<T>)
    : fallback;
}

function clampTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10;
  return Math.min(20, Math.max(3, Math.trunc(value)));
}

export function normalizeGeneratedPersona(input: unknown): NormalizedGeneratedPersona {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const isAdversarial = source.isAdversarial === true;
  const adversarialType = oneOf(source.adversarialType, VALID_ADVERSARIAL_TYPES, 'edge_case');

  return {
    name: cleanString(source.name) ?? 'Generated Persona',
    description: cleanString(source.description) ?? 'AI-generated persona',
    communicationStyle: oneOf(source.communicationStyle, VALID_COMMUNICATION_STYLES, 'casual'),
    domainKnowledge: oneOf(source.domainKnowledge, VALID_DOMAIN_KNOWLEDGE, 'intermediate'),
    behaviorTraits: cleanStringArray(source.behaviorTraits, 6),
    goals: cleanString(source.goals) ?? '',
    constraints: cleanString(source.constraints) ?? '',
    isAdversarial,
    ...(isAdversarial ? { adversarialType } : {}),
  };
}

export function normalizeGeneratedScenario(
  input: unknown,
  validAgentNames: readonly string[] = [],
): NormalizedGeneratedScenario {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const name = cleanString(source.name) ?? 'Generated Scenario';
  const description = cleanString(source.description) ?? 'AI-generated scenario';
  const expectedMilestones = cleanStringArray(source.expectedMilestones, 5);
  const validAgentSet = new Set(validAgentNames);
  const fallbackAgent = validAgentNames[0];
  const rawEntryAgent = cleanString(source.entryAgent);
  const entryAgent =
    rawEntryAgent && (validAgentSet.size === 0 || validAgentSet.has(rawEntryAgent))
      ? rawEntryAgent
      : fallbackAgent;
  const agentPath = cleanStringArray(source.agentPath, 10).filter(
    (agentName) => validAgentSet.size === 0 || validAgentSet.has(agentName),
  );
  const fallbackInitialMessage = `I need help: ${description.replace(/[.?!]+$/, '')}.`;
  const fallbackExpectedOutcome =
    expectedMilestones.length > 0
      ? expectedMilestones.join('; ')
      : 'The agent completes the scenario successfully and follows the expected path.';

  return {
    name,
    description,
    category: oneOf(source.category, VALID_SCENARIO_CATEGORIES, 'happy_path'),
    difficulty: oneOf(source.difficulty, VALID_DIFFICULTIES, 'medium'),
    entryAgent,
    initialMessage: cleanString(source.initialMessage) ?? fallbackInitialMessage,
    expectedOutcome: cleanString(source.expectedOutcome) ?? fallbackExpectedOutcome,
    maxTurns: clampTurns(source.maxTurns),
    expectedMilestones,
    agentPath,
    tags: cleanStringArray(source.tags, 3),
  };
}
