import type { ConversationBehaviorAST } from '@abl/core';

import type { CompilationError } from './schema.js';

const DEFERRED_FIELD_ERRORS: Array<{
  path: string;
  isPresent: (conversation: ConversationBehaviorAST) => boolean;
}> = [
  {
    path: 'speaking.variety',
    isPresent: (conversation) => conversation.speaking?.variety !== undefined,
  },
  {
    path: 'listening.backchannels',
    isPresent: (conversation) => conversation.listening?.backchannels !== undefined,
  },
  {
    path: 'listening.use_audio_cues',
    isPresent: (conversation) => conversation.listening?.use_audio_cues !== undefined,
  },
  {
    path: 'interaction.assumption_handling',
    isPresent: (conversation) => conversation.interaction?.assumption_handling !== undefined,
  },
  {
    path: 'interaction.guidance',
    isPresent: (conversation) => conversation.interaction?.guidance !== undefined,
  },
  {
    path: 'interaction.failure_recovery',
    isPresent: (conversation) => conversation.interaction?.failure_recovery !== undefined,
  },
  {
    path: 'interaction.adaptation',
    isPresent: (conversation) => conversation.interaction?.adaptation !== undefined,
  },
  {
    path: 'interaction.flow_mode',
    isPresent: (conversation) => conversation.interaction?.flow_mode !== undefined,
  },
];

const LANGUAGE_POLICIES = new Set(['interaction_context', 'agent_default', 'fixed']);

export function validateConversationBehavior(
  conversation: ConversationBehaviorAST,
  agentName: string,
): CompilationError[] {
  const errors: CompilationError[] = [];

  for (const deferredField of DEFERRED_FIELD_ERRORS) {
    if (!deferredField.isPresent(conversation)) {
      continue;
    }

    errors.push({
      agent: agentName,
      code: 'CONVERSATION_DEFERRED_FIELD',
      path: deferredField.path,
      message: `${deferredField.path} is not in the phase-1 Conversation Behavior subset yet.`,
      type: 'validation',
    });
  }

  const languagePolicy = conversation.speaking?.language_policy;
  if (languagePolicy !== undefined && !LANGUAGE_POLICIES.has(languagePolicy)) {
    errors.push({
      agent: agentName,
      code: 'CONVERSATION_INVALID_VALUE',
      path: 'speaking.language_policy',
      message:
        'speaking.language_policy must be one of interaction_context, agent_default, or fixed.',
      type: 'validation',
    });
  }

  if (
    conversation.speaking?.fixed_language !== undefined &&
    conversation.speaking.language_policy !== 'fixed'
  ) {
    errors.push({
      agent: agentName,
      code: 'CONVERSATION_INVALID_COMBINATION',
      path: 'speaking.fixed_language',
      message: 'speaking.fixed_language requires speaking.language_policy to be set to "fixed".',
      type: 'validation',
    });
  }

  if (conversation.speaking?.language_policy === 'fixed' && !conversation.speaking.fixed_language) {
    errors.push({
      agent: agentName,
      code: 'CONVERSATION_INVALID_COMBINATION',
      path: 'speaking.language_policy',
      message:
        'speaking.language_policy set to "fixed" requires speaking.fixed_language to be provided.',
      type: 'validation',
    });
  }

  validatePositiveInteger(
    conversation.speaking?.max_sentences,
    'speaking.max_sentences',
    agentName,
    errors,
  );
  validatePositiveInteger(
    conversation.speaking?.tool_results?.max_points,
    'speaking.tool_results.max_points',
    agentName,
    errors,
  );
  validatePositiveInteger(
    conversation.interaction?.clarification?.max_questions,
    'interaction.clarification.max_questions',
    agentName,
    errors,
  );
  validatePositiveInteger(
    conversation.interaction?.repair?.max_attempts,
    'interaction.repair.max_attempts',
    agentName,
    errors,
  );

  return errors;
}

function validatePositiveInteger(
  value: number | undefined,
  path: string,
  agentName: string,
  errors: CompilationError[],
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 1) {
    errors.push({
      agent: agentName,
      code: 'CONVERSATION_INVALID_VALUE',
      path,
      message: `${path} must be a positive integer.`,
      type: 'validation',
    });
  }
}
