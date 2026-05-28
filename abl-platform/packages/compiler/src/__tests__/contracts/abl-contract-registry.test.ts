import { describe, expect, test } from 'vitest';
import { BUILTIN_FUNCTIONS } from '../../platform/constructs/evaluator.js';
import {
  BUILTIN_FIELD_REFERENCE_VARS,
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  HANDOFF_ON_RETURN_ACTION_VALUES,
  HANDOFF_TIMEOUT_ACTION_VALUES,
} from '../../platform/contracts/contract-source-data.js';
import { getAblContractRegistry } from '../../platform/contracts/index.js';

describe('ABL contract registry', () => {
  test('covers every resolveValue built-in exactly once', () => {
    const registry = getAblContractRegistry();
    const registryFunctions = registry.builtInFunctions.functions.map((fn) => fn.name).sort();
    const runtimeFunctions = Object.keys(BUILTIN_FUNCTIONS).sort();

    expect(registry.builtInFunctions.count).toBe(runtimeFunctions.length);
    expect(registryFunctions).toEqual(runtimeFunctions);
  });

  test('documents canonical lifecycle events and history strategies', () => {
    const registry = getAblContractRegistry();

    expect(registry.lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical: 'session:start',
          legacyAliases: [],
        }),
        expect.objectContaining({
          canonical: 'agent:*:after',
          legacyAliases: [],
        }),
      ]),
    );

    expect(registry.historyStrategies.map((strategy) => strategy.name)).toEqual([
      'auto',
      'none',
      'summary_only',
      'full',
      'last_n',
    ]);

    expect(
      registry.historyStrategies.find(
        (strategy) => strategy.name === DEFAULT_HANDOFF_HISTORY_STRATEGY,
      ),
    ).toEqual(
      expect.objectContaining({
        description: expect.stringContaining('default'),
      }),
    );
    expect(registry.historyStrategies.find((strategy) => strategy.name === 'auto')).toEqual(
      expect.objectContaining({
        description: expect.stringContaining(String(DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N)),
      }),
    );
  });

  test('stays aligned with coordination action and system-variable sources', () => {
    const registry = getAblContractRegistry();

    expect(
      registry.coordinationActions
        .filter((action) => action.surface === 'handoff.on_timeout')
        .map((action) => action.syntax),
    ).toEqual(expect.arrayContaining([...HANDOFF_TIMEOUT_ACTION_VALUES, 'respond:<message>']));

    expect(
      registry.coordinationActions
        .filter((action) => action.surface === 'handoff.on_return')
        .map((action) => action.syntax),
    ).toEqual(expect.arrayContaining([...HANDOFF_ON_RETURN_ACTION_VALUES]));

    const fieldReferenceVariables = registry.systemVariables
      .filter((variable) => variable.surfaces.includes('field_reference'))
      .map((variable) => variable.name)
      .sort();

    expect(fieldReferenceVariables).toEqual([...BUILTIN_FIELD_REFERENCE_VARS].sort());

    expect(registry.systemVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'user_id',
          surfaces: expect.arrayContaining(['tool_param_injection']),
        }),
        expect.objectContaining({
          name: 'last_<tool_name>_result',
          surfaces: expect.arrayContaining(['session_value_pattern']),
        }),
      ]),
    );

    expect(registry.compatibilityNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'handoff.history-default',
          summary: expect.stringContaining(DEFAULT_HANDOFF_HISTORY_STRATEGY),
        }),
        expect.objectContaining({
          id: 'handoff.machine-targets',
        }),
      ]),
    );
    expect(registry.compatibilityNotes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'handoff.on-return-shorthand' }),
        expect.objectContaining({ id: 'handoff.grant-memory-shorthand' }),
        expect.objectContaining({ id: 'recall.legacy-event-aliases' }),
      ]),
    );

    expect(registry.constructs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'handoff.return_handlers',
          support: 'wired',
        }),
        expect.objectContaining({
          id: 'handoff.context.memory_grants',
          support: 'wired',
        }),
        expect.objectContaining({
          id: 'memory.persistent.execution_tree',
          support: 'wired',
        }),
        expect.objectContaining({
          id: 'lookup_tables.agent_local',
          stability: 'experimental',
        }),
      ]),
    );
  });
});
