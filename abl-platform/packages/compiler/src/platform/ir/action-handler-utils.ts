import type { ActionHandlerActionIR, ActionHandlerIR } from './schema.js';

export type ActionHandlerTraversalTarget = Pick<
  ActionHandlerIR,
  'do' | 'respond' | 'voice_config' | 'rich_content' | 'actions' | 'set' | 'transition'
>;

export interface MutableActionHandlerActionRef {
  action: ActionHandlerActionIR;
  sync?: (action: ActionHandlerActionIR) => void;
}

/**
 * Return action-handler actions in canonical execution order.
 *
 * `do[]` is the source of truth after compilation. The legacy top-level
 * fields remain as compatibility mirrors for older IR consumers and tests.
 */
export function getActionHandlerActions(
  handler: ActionHandlerTraversalTarget,
): ActionHandlerActionIR[] {
  if (handler.do && handler.do.length > 0) {
    return handler.do;
  }

  const actions: ActionHandlerActionIR[] = [];
  if (handler.set) {
    actions.push({ set: handler.set });
  }
  if (handler.respond !== undefined) {
    actions.push({
      respond: handler.respond,
      voice_config: handler.voice_config,
      rich_content: handler.rich_content,
      actions: handler.actions,
    });
  }
  if (handler.transition) {
    actions.push({ goto: handler.transition });
  }
  return actions;
}

/**
 * Return mutable action references for compiler post-processing passes.
 *
 * When `do[]` exists we return live references. When only compatibility
 * mirrors exist we synthesize ordered actions and provide a `sync()` callback
 * that writes mutations back to the legacy fields.
 */
export function getMutableActionHandlerActionRefs(
  handler: ActionHandlerTraversalTarget,
): MutableActionHandlerActionRef[] {
  if (handler.do && handler.do.length > 0) {
    return handler.do.map((action) => ({ action }));
  }

  const refs: MutableActionHandlerActionRef[] = [];
  if (handler.set) {
    refs.push({
      action: { set: handler.set },
      sync: (action) => {
        handler.set = action.set;
      },
    });
  }
  if (handler.respond !== undefined) {
    refs.push({
      action: {
        respond: handler.respond,
        voice_config: handler.voice_config,
        rich_content: handler.rich_content,
        actions: handler.actions,
      },
      sync: (action) => {
        handler.respond = action.respond;
        handler.voice_config = action.voice_config;
        handler.rich_content = action.rich_content;
        handler.actions = action.actions;
      },
    });
  }
  if (handler.transition) {
    refs.push({
      action: { goto: handler.transition },
      sync: (action) => {
        handler.transition = action.goto;
      },
    });
  }
  return refs;
}

/**
 * Keep compatibility mirrors aligned with the canonical `do[]` action list.
 *
 * This is only relevant for handlers authored through legacy top-level fields,
 * because compilation preserves those fields alongside the lowered `do[]`.
 */
export function syncActionHandlerCompatibilityMirrors(handler: ActionHandlerTraversalTarget): void {
  if (!handler.do || handler.do.length === 0) {
    return;
  }

  handler.set = handler.do.find((action) => action.set)?.set;

  const respondAction = handler.do.find((action) => action.respond !== undefined);
  handler.respond = respondAction?.respond;
  handler.voice_config = respondAction?.voice_config;
  handler.rich_content = respondAction?.rich_content;
  handler.actions = respondAction?.actions;

  handler.transition = handler.do.find((action) => action.goto)?.goto;
}
