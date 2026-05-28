/**
 * Cross-Agent Reference Validator
 *
 * Checks that handoff, delegate, routing, on_start.delegate, and
 * error_handling.handoff_target references point to agents that
 * exist in the compilation. Uses the same handoff target normalization
 * as runtime authority resolution so lowered/normalized targets stay aligned.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';
import { getActionHandlerActions } from './action-handler-utils.js';
import {
  collectHandoffTargetReferences,
  normalizeHandoffTarget,
} from '../constructs/executors/handoff-authority.js';

function addKnownProducedField(fields: Set<string>, value: string | undefined): void {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return;
  }

  fields.add(normalized);
  if (normalized.includes('.')) {
    fields.add(normalized.split('.')[0]);
  }
}

function addKnownProducedFieldsFromRecord(
  fields: Set<string>,
  record: Record<string, unknown> | undefined,
): void {
  if (!record) {
    return;
  }

  for (const key of Object.keys(record)) {
    addKnownProducedField(fields, key);
  }
}

function getDigressionActions(digression: {
  do?: Array<{
    set?: Record<string, unknown>;
    call_spec?: { as?: string };
    on_return?: { map?: Record<string, string> };
  }>;
  set?: Record<string, unknown>;
  call_spec?: { as?: string };
}): Array<{
  set?: Record<string, unknown>;
  call_spec?: { as?: string };
  on_return?: { map?: Record<string, string> };
}> {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  if (digression.set || digression.call_spec) {
    return [{ set: digression.set, call_spec: digression.call_spec }];
  }

  return [];
}

function collectKnownProducedFields(agent: AgentIR): Set<string> {
  const fields = new Set<string>();

  for (const field of agent.gather?.fields ?? []) {
    addKnownProducedField(fields, field.name);
  }

  for (const sessionVar of agent.memory?.session ?? []) {
    addKnownProducedField(fields, sessionVar.name);
  }

  for (const persistent of agent.memory?.persistent ?? []) {
    addKnownProducedField(fields, persistent.path);
  }

  for (const recall of agent.memory?.recall ?? []) {
    if (recall.action?.type === 'inject_context') {
      for (const path of recall.action.paths) {
        addKnownProducedField(fields, path);
      }
    }
  }

  addKnownProducedFieldsFromRecord(fields, agent.on_start?.set);
  addKnownProducedField(fields, agent.on_start?.call_spec?.as);

  for (const tool of agent.tools ?? []) {
    if (tool.store_result !== false) {
      addKnownProducedField(fields, `last_${tool.name}_result`);
    }
    addKnownProducedFieldsFromRecord(fields, tool.on_result?.set);
    addKnownProducedFieldsFromRecord(fields, tool.on_error?.set);

    for (const fieldName of Object.keys(tool.returns?.fields ?? {})) {
      addKnownProducedField(fields, fieldName);
    }
  }

  for (const handoff of agent.coordination?.handoffs ?? []) {
    if (handoff.on_return && typeof handoff.on_return === 'object' && handoff.on_return.map) {
      for (const parentVar of Object.values(handoff.on_return.map)) {
        addKnownProducedField(fields, parentVar);
      }
    }
  }

  for (const delegate of agent.coordination?.delegates ?? []) {
    addKnownProducedField(fields, delegate.use_result);
    for (const parentVar of Object.values(delegate.returns ?? {})) {
      addKnownProducedField(fields, parentVar);
    }
  }

  for (const handler of agent.action_handlers ?? []) {
    for (const action of getActionHandlerActions(handler)) {
      addKnownProducedFieldsFromRecord(fields, action.set);
      addKnownProducedField(fields, action.result_key);
      addKnownProducedField(fields, action.call_spec?.as);
      for (const parentVar of Object.values(action.on_return?.map ?? {})) {
        addKnownProducedField(fields, parentVar);
      }
    }
  }

  for (const step of Object.values(agent.flow?.definitions ?? {})) {
    for (const field of step.gather?.fields ?? []) {
      addKnownProducedField(fields, field.name);
    }

    addKnownProducedField(fields, step.call_as);
    addKnownProducedField(fields, step.call_spec?.as);
    addKnownProducedField(fields, step.transform?.target);

    for (const assignment of step.set ?? []) {
      addKnownProducedField(fields, assignment.variable);
    }

    for (const branch of step.on_input ?? []) {
      addKnownProducedFieldsFromRecord(fields, branch.set);
      addKnownProducedField(fields, branch.call_spec?.as);
    }
    for (const branch of step.on_result ?? []) {
      addKnownProducedFieldsFromRecord(fields, branch.set);
      addKnownProducedField(fields, branch.call_spec?.as);
    }
    for (const branch of step.on_success?.branches ?? []) {
      addKnownProducedFieldsFromRecord(fields, branch.set);
      addKnownProducedField(fields, branch.call_spec?.as);
    }
    for (const branch of step.on_failure?.branches ?? []) {
      addKnownProducedFieldsFromRecord(fields, branch.set);
      addKnownProducedField(fields, branch.call_spec?.as);
    }
    for (const handler of step.on_action ?? []) {
      for (const action of getActionHandlerActions(handler)) {
        addKnownProducedFieldsFromRecord(fields, action.set);
        addKnownProducedField(fields, action.result_key);
        addKnownProducedField(fields, action.call_spec?.as);
        for (const parentVar of Object.values(action.on_return?.map ?? {})) {
          addKnownProducedField(fields, parentVar);
        }
      }
    }
    for (const digression of step.digressions ?? []) {
      addKnownProducedField(fields, digression.call_spec?.as);
      for (const action of getDigressionActions(digression)) {
        addKnownProducedFieldsFromRecord(fields, action.set);
        addKnownProducedField(fields, action.call_spec?.as);
        for (const parentVar of Object.values(action.on_return?.map ?? {})) {
          addKnownProducedField(fields, parentVar);
        }
      }
    }
    for (const subIntent of step.sub_intents ?? []) {
      addKnownProducedFieldsFromRecord(fields, subIntent.set);
      addKnownProducedField(fields, subIntent.call_spec?.as);
    }
  }

  for (const digression of agent.flow?.global_digressions ?? []) {
    addKnownProducedField(fields, digression.call_spec?.as);
    for (const action of getDigressionActions(digression)) {
      addKnownProducedFieldsFromRecord(fields, action.set);
      addKnownProducedField(fields, action.call_spec?.as);
      for (const parentVar of Object.values(action.on_return?.map ?? {})) {
        addKnownProducedField(fields, parentVar);
      }
    }
  }

  return fields;
}

function validateReturnFieldMappings(
  agent: AgentIR,
  allAgents: AgentIR[],
  opts: { singleAgentScope?: boolean },
): ValidationDiagnostic[] {
  if (opts.singleAgentScope) {
    return [];
  }

  const diagnostics: ValidationDiagnostic[] = [];
  const agentName = agent.metadata.name;
  const agentsByName = new Map(allAgents.map((candidate) => [candidate.metadata.name, candidate]));

  for (let i = 0; i < (agent.coordination?.handoffs?.length ?? 0); i++) {
    const handoff = agent.coordination!.handoffs[i];
    if (handoff.remote?.location === 'remote') {
      continue;
    }
    if (!handoff.return || typeof handoff.on_return !== 'object' || !handoff.on_return?.map) {
      continue;
    }

    const target = agentsByName.get(handoff.to);
    if (!target) {
      continue;
    }

    const targetFields = collectKnownProducedFields(target);
    for (const [childKey, parentKey] of Object.entries(handoff.on_return.map)) {
      if (!targetFields.has(childKey)) {
        diagnostics.push({
          agent: agentName,
          message: `HANDOFF ON_RETURN maps child field "${childKey}" from "${handoff.to}" into parent field "${parentKey}", but "${handoff.to}" does not declare or obviously produce "${childKey}".`,
          referenced_agent: handoff.to,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.UNKNOWN_HANDOFF_RETURN_FIELD,
          path: `coordination.handoffs[${i}].on_return.map.${childKey}`,
        });
      }
    }
  }

  for (let i = 0; i < (agent.coordination?.delegates?.length ?? 0); i++) {
    const delegate = agent.coordination!.delegates[i];
    if (delegate.remote?.location === 'remote') {
      continue;
    }

    const target = agentsByName.get(delegate.agent);
    if (!target) {
      continue;
    }

    const targetFields = collectKnownProducedFields(target);
    for (const [childKey, parentKey] of Object.entries(delegate.returns ?? {})) {
      if (!targetFields.has(childKey)) {
        diagnostics.push({
          agent: agentName,
          message: `DELEGATE RETURNS maps child field "${childKey}" from "${delegate.agent}" into parent field "${parentKey}", but "${delegate.agent}" does not declare or obviously produce "${childKey}".`,
          referenced_agent: delegate.agent,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.UNKNOWN_DELEGATE_RETURN_FIELD,
          path: `coordination.delegates[${i}].returns.${childKey}`,
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Validate cross-agent references against the set of all compiled agents.
 */
export function validateCrossAgentRefs(
  agent: AgentIR,
  allAgents: AgentIR[],
  opts: { singleAgentScope?: boolean } = {},
): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];
  const remoteHandoffTargets = new Set(
    (agent.coordination?.handoffs ?? [])
      .filter((handoff) => handoff.remote?.location === 'remote')
      .map((handoff) => handoff.to),
  );
  const declaredHandoffTargets = new Set((agent.coordination?.handoffs ?? []).map((h) => h.to));
  const remoteDelegateTargets = new Set(
    (agent.coordination?.delegates ?? [])
      .filter((delegate) => delegate.remote?.location === 'remote')
      .map((delegate) => delegate.agent),
  );
  const declaredDelegateTargets = new Set(
    (agent.coordination?.delegates ?? []).map((delegate) => delegate.agent),
  );

  // Build set of known agent names
  const knownAgents = new Set(allAgents.map((a) => a.metadata.name));

  const checkAgent = (target: string, code: string, path: string, label: string) => {
    if (opts.singleAgentScope) {
      return;
    }
    if (!knownAgents.has(target)) {
      diagnostics.push({
        agent: agentName,
        message: `${label} "${target}" does not exist in this compilation. Known agents: ${[...knownAgents].join(', ')}`,
        referenced_agent: target,
        type: 'validation',
        severity: 'error',
        code,
        path,
      });
    }
  };

  const checkNotSelf = (target: string, code: string, path: string, label: string) => {
    if (target === agentName) {
      diagnostics.push({
        agent: agentName,
        message: `${label} "${target}" cannot reference the current agent "${agentName}".`,
        referenced_agent: target,
        type: 'validation',
        severity: 'error',
        code,
        path,
      });
    }
  };

  const getDigressionDelegates = (digression: {
    do?: Array<{ delegate?: string }>;
    delegate?: string;
  }): string[] => {
    if (digression.do && digression.do.length > 0) {
      return digression.do
        .map((action) => action.delegate)
        .filter((target): target is string => !!target);
    }
    return digression.delegate ? [digression.delegate] : [];
  };

  const checkActionHandlerHandoff = (target: string, path: string) => {
    const normalizedTarget = normalizeHandoffTarget(target) ?? target;
    checkNotSelf(
      normalizedTarget,
      VALIDATION_CODES.SELF_HANDOFF_TARGET,
      path,
      'ON_ACTION handoff target',
    );

    if (!opts.singleAgentScope && !declaredHandoffTargets.has(normalizedTarget)) {
      diagnostics.push({
        agent: agentName,
        message: `ON_ACTION handoff target "${normalizedTarget}" must be declared in this agent's HANDOFF configuration.`,
        referenced_agent: normalizedTarget,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        path,
      });
      return;
    }

    if (!remoteHandoffTargets.has(normalizedTarget)) {
      checkAgent(
        normalizedTarget,
        VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        path,
        'ON_ACTION handoff target',
      );
    }
  };

  const checkActionHandlerDelegate = (target: string, path: string) => {
    checkNotSelf(target, VALIDATION_CODES.SELF_DELEGATE_TARGET, path, 'ON_ACTION delegate target');

    if (!opts.singleAgentScope && !declaredDelegateTargets.has(target)) {
      diagnostics.push({
        agent: agentName,
        message: `ON_ACTION delegate target "${target}" must be declared in this agent's DELEGATE configuration.`,
        referenced_agent: target,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        path,
      });
      return;
    }

    if (!remoteDelegateTargets.has(target)) {
      checkAgent(
        target,
        VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        path,
        'ON_ACTION delegate target',
      );
    }
  };

  const checkActionHandlers = (handlers: AgentIR['action_handlers'], pathPrefix: string) => {
    if (!handlers) {
      return;
    }
    for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
      const actions = getActionHandlerActions(handlers[handlerIndex]);
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        const action = actions[actionIndex];
        if (action.handoff) {
          checkActionHandlerHandoff(
            action.handoff,
            `${pathPrefix}[${handlerIndex}].do[${actionIndex}].handoff`,
          );
        }
        if (action.delegate) {
          checkActionHandlerDelegate(
            action.delegate,
            `${pathPrefix}[${handlerIndex}].do[${actionIndex}].delegate`,
          );
        }
      }
    }
  };

  // Supervisor declared agent set
  if (agent.available_agents) {
    for (let i = 0; i < agent.available_agents.length; i++) {
      const target = agent.available_agents[i];
      checkNotSelf(
        target,
        VALIDATION_CODES.SELF_ROUTING_TARGET,
        `available_agents[${i}]`,
        'Supervisor available_agents entry',
      );
      if (!remoteHandoffTargets.has(target)) {
        checkAgent(
          target,
          VALIDATION_CODES.INVALID_ROUTING_TARGET,
          `available_agents[${i}]`,
          'Supervisor available_agents entry',
        );
      }
    }
  }

  for (const ref of collectHandoffTargetReferences(agent)) {
    const selfCode =
      ref.source === 'routing'
        ? VALIDATION_CODES.SELF_ROUTING_TARGET
        : VALIDATION_CODES.SELF_HANDOFF_TARGET;
    const invalidCode =
      ref.source === 'routing'
        ? VALIDATION_CODES.INVALID_ROUTING_TARGET
        : VALIDATION_CODES.INVALID_HANDOFF_TARGET;
    const label =
      ref.source === 'routing'
        ? 'Routing target'
        : ref.source === 'constraint'
          ? 'Constraint handoff target'
          : 'Handoff target';

    checkNotSelf(ref.target, selfCode, ref.path, label);
    const skipExistenceCheck =
      ref.remote || (ref.source === 'routing' && remoteHandoffTargets.has(ref.target));
    if (!skipExistenceCheck) {
      checkAgent(ref.target, invalidCode, ref.path, label);
    }
  }

  // Delegates
  if (agent.coordination?.delegates) {
    for (let i = 0; i < agent.coordination.delegates.length; i++) {
      const d = agent.coordination.delegates[i];
      // Skip remote delegates
      if ((d as any).remote?.location === 'remote') continue;
      checkNotSelf(
        d.agent,
        VALIDATION_CODES.SELF_DELEGATE_TARGET,
        `coordination.delegates[${i}].agent`,
        'Delegate target',
      );
      checkAgent(
        d.agent,
        VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        `coordination.delegates[${i}].agent`,
        'Delegate target',
      );
    }
  }

  // on_start.delegate
  if (agent.on_start?.delegate) {
    checkNotSelf(
      agent.on_start.delegate,
      VALIDATION_CODES.SELF_DELEGATE_TARGET,
      'on_start.delegate',
      'on_start delegate target',
    );
    checkAgent(
      agent.on_start.delegate,
      VALIDATION_CODES.INVALID_DELEGATE_TARGET,
      'on_start.delegate',
      'on_start delegate target',
    );
  }

  checkActionHandlers(agent.action_handlers ?? [], 'action_handlers');

  if (agent.flow?.definitions) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      checkActionHandlers(step.on_action ?? [], `flow.steps.${stepName}.on_action`);

      if (step.digressions) {
        for (let i = 0; i < step.digressions.length; i++) {
          for (const target of getDigressionDelegates(step.digressions[i])) {
            checkNotSelf(
              target,
              VALIDATION_CODES.SELF_DELEGATE_TARGET,
              `flow.steps.${stepName}.digressions[${i}].delegate`,
              'Digression delegate target',
            );
            checkAgent(
              target,
              VALIDATION_CODES.INVALID_DELEGATE_TARGET,
              `flow.steps.${stepName}.digressions[${i}].delegate`,
              'Digression delegate target',
            );
          }
        }
      }
    }

    if (agent.flow.global_digressions) {
      for (let i = 0; i < agent.flow.global_digressions.length; i++) {
        for (const target of getDigressionDelegates(agent.flow.global_digressions[i])) {
          checkNotSelf(
            target,
            VALIDATION_CODES.SELF_DELEGATE_TARGET,
            `flow.global_digressions[${i}].delegate`,
            'Global digression delegate target',
          );
          checkAgent(
            target,
            VALIDATION_CODES.INVALID_DELEGATE_TARGET,
            `flow.global_digressions[${i}].delegate`,
            'Global digression delegate target',
          );
        }
      }
    }
  }

  // error_handling.handlers[].handoff_target
  if (agent.error_handling?.handlers) {
    for (let i = 0; i < agent.error_handling.handlers.length; i++) {
      const handler = agent.error_handling.handlers[i];
      if (handler.handoff_target) {
        const target = normalizeHandoffTarget(handler.handoff_target) ?? handler.handoff_target;
        checkNotSelf(
          target,
          VALIDATION_CODES.SELF_HANDOFF_TARGET,
          `error_handling.handlers[${i}].handoff_target`,
          'Error handler handoff target',
        );
        checkAgent(
          target,
          VALIDATION_CODES.INVALID_HANDOFF_TARGET,
          `error_handling.handlers[${i}].handoff_target`,
          'Error handler handoff target',
        );
      }
    }
  }

  diagnostics.push(...validateReturnFieldMappings(agent, allAgents, opts));

  return diagnostics;
}
