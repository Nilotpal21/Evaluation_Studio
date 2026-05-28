import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalsAssembler } from '../export/layer-assemblers/evals-assembler.js';

vi.mock('@agent-platform/database/models', () => ({
  EvalSet: { find: vi.fn(), countDocuments: vi.fn() },
  EvalScenario: { find: vi.fn(), countDocuments: vi.fn() },
  EvalPersona: { find: vi.fn(), countDocuments: vi.fn() },
  EvalEvaluator: { find: vi.fn(), countDocuments: vi.fn() },
}));

import { EvalSet, EvalScenario, EvalPersona, EvalEvaluator } from '@agent-platform/database/models';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  return { lean: () => ({ select: () => Promise.resolve(data) }) };
}

describe('EvalsAssembler', () => {
  let assembler: EvalsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new EvalsAssembler();
  });

  it('should have layer name "evals"', () => {
    expect(assembler.layer).toBe('evals');
  });

  it('should assemble eval sets with nested scenarios and personas', async () => {
    (EvalSet.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'set-1',
          name: 'Regression Suite',
          description: 'Main regression tests',
          personaIds: ['persona-1'],
          scenarioIds: ['scenario-1'],
          evaluatorIds: ['eval-1'],
          variants: 3,
          maxConcurrency: 2,
          ciEnabled: true,
          createdBy: 'user-1',
        },
      ]),
    );
    (EvalScenario.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'scenario-1',
          name: 'Happy Path',
          description: 'Basic conversation',
          category: 'general',
          difficulty: 'easy',
          entryAgent: 'Supervisor',
          initialMessage: 'Hello',
          maxTurns: 10,
          tags: ['basic'],
          agentPath: ['Supervisor'],
          expectedMilestones: ['greeting'],
          createdBy: 'user-1',
        },
      ]),
    );
    (EvalPersona.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'persona-1',
          name: 'Casual User',
          description: 'A typical end user',
          communicationStyle: 'casual',
          domainKnowledge: 'beginner',
          behaviorTraits: ['friendly'],
          goals: 'Get help',
          constraints: 'None',
          sessionVariables: { consumer_id: 'consumer-123', contract_id: 'contract-456' },
          source: 'custom',
          isAdversarial: false,
          isBuiltIn: false,
          createdBy: 'user-1',
        },
      ]),
    );
    (EvalEvaluator.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'eval-1',
          name: 'Quality Judge',
          description: 'Checks response quality',
          type: 'llm_judge',
          category: 'quality',
          chainOfThought: true,
          temperature: 0.3,
          isBuiltIn: false,
          createdBy: 'user-1',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.layer).toBe('evals');
    expect(result.files.has('evals/regression_suite/eval-set.json')).toBe(true);
    expect(result.files.has('evals/regression_suite/scenarios/happy_path.scenario.json')).toBe(
      true,
    );
    expect(result.files.has('evals/regression_suite/personas/casual_user.persona.json')).toBe(true);
    const personaJson = result.files.get(
      'evals/regression_suite/personas/casual_user.persona.json',
    )!;
    expect(JSON.parse(personaJson).sessionVariables).toEqual({
      consumer_id: 'consumer-123',
      contract_id: 'contract-456',
    });
    expect(result.files.has('evals/evaluators/quality_judge.evaluator.json')).toBe(true);
    expect(result.entityCount).toBeGreaterThan(0);
  });

  it('should strip internal fields from output', async () => {
    (EvalSet.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalScenario.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalPersona.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalEvaluator.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'eval-1',
          __v: 0,
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          name: 'Safety Check',
          type: 'llm_judge',
          category: 'safety',
          chainOfThought: true,
          temperature: 0.1,
          isBuiltIn: true,
          createdBy: 'system',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);
    const evaluatorJson = result.files.get('evals/evaluators/safety_check.evaluator.json')!;
    const parsed = JSON.parse(evaluatorJson);

    expect(parsed).not.toHaveProperty('_id');
    expect(parsed).not.toHaveProperty('__v');
    expect(parsed).not.toHaveProperty('projectId');
    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
    expect(parsed.name).toBe('Safety Check');
  });

  it('should warn about missing scenario references', async () => {
    (EvalSet.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'set-1',
          name: 'Broken Set',
          personaIds: [],
          scenarioIds: ['missing-scenario'],
          evaluatorIds: [],
          createdBy: 'user-1',
        },
      ]),
    );
    (EvalScenario.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalPersona.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalEvaluator.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('missing scenario');
  });

  it('keeps colliding eval set directories distinct', async () => {
    (EvalSet.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'set-1',
          name: 'Regression Suite',
          personaIds: [],
          scenarioIds: ['scenario-1'],
          evaluatorIds: [],
          createdBy: 'user-1',
        },
        {
          _id: 'set-2',
          name: 'Regression/Suite',
          personaIds: [],
          scenarioIds: ['scenario-2'],
          evaluatorIds: [],
          createdBy: 'user-1',
        },
      ]),
    );
    (EvalScenario.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        { _id: 'scenario-1', name: 'Happy Path', createdBy: 'user-1' },
        { _id: 'scenario-2', name: 'Happy/Path', createdBy: 'user-1' },
      ]),
    );
    (EvalPersona.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalEvaluator.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('evals/regression_suite/eval-set.json')).toBe(true);
    expect(result.files.has('evals/regression_suite_2/eval-set.json')).toBe(true);
    expect(result.files.has('evals/regression_suite/scenarios/happy_path.scenario.json')).toBe(
      true,
    );
    expect(result.files.has('evals/regression_suite_2/scenarios/happy_path.scenario.json')).toBe(
      true,
    );
    expect(JSON.parse(result.files.get('evals/regression_suite/eval-set.json')!).name).toBe(
      'Regression Suite',
    );
    expect(JSON.parse(result.files.get('evals/regression_suite_2/eval-set.json')!).name).toBe(
      'Regression/Suite',
    );
  });

  it('should handle empty project with no evals', async () => {
    (EvalSet.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalScenario.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalPersona.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (EvalEvaluator.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.layer).toBe('evals');
    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('should count entities correctly', async () => {
    (EvalSet.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (EvalScenario.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (EvalPersona.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (EvalEvaluator.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(4);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(14);
  });
});
