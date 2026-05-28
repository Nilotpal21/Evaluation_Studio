export type EvalRunErrorCategory =
  | 'eval_set_not_found'
  | 'entity_access_denied'
  | 'preflight_failed'
  | 'run_cancelled'
  | 'terminal_error'
  | 'unknown';

export interface EvalRunErrorClassification {
  category: EvalRunErrorCategory;
  message: string;
  terminal: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyEvalRunError(error: unknown): EvalRunErrorClassification {
  const message = getErrorMessage(error);

  if (/^EvalSet .+ not found$/.test(message)) {
    return { category: 'eval_set_not_found', message, terminal: true };
  }

  if (/^One or more (personas|scenarios|evaluators) not found or access denied$/.test(message)) {
    return { category: 'entity_access_denied', message, terminal: true };
  }

  if (message.startsWith('Eval preflight failed:')) {
    return { category: 'preflight_failed', message, terminal: true };
  }

  if (message === 'Run cancelled or not found') {
    return { category: 'run_cancelled', message, terminal: true };
  }

  return { category: 'unknown', message, terminal: false };
}
