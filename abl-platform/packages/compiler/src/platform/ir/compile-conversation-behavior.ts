import type { ConversationBehaviorAST } from '@abl/core';

import type {
  CompilationError,
  ConversationBehaviorIR,
  ConversationInteractionIR,
  ConversationListeningIR,
  ConversationSpeakingIR,
} from './schema.js';
import { validateConversationBehavior } from './validate-conversation-behavior.js';

export function compileConversationBehavior(
  conversation: ConversationBehaviorAST,
  agentName: string,
): {
  conversationBehavior?: ConversationBehaviorIR;
  errors: CompilationError[];
} {
  const errors = validateConversationBehavior(conversation, agentName);
  if (errors.length > 0) {
    return { errors };
  }

  const conversationBehavior: ConversationBehaviorIR = {};

  if (conversation.speaking) {
    const speaking = compileConversationSpeaking(conversation.speaking);
    if (speaking) {
      conversationBehavior.speaking = speaking;
    }
  }

  if (conversation.listening) {
    const listening = compileConversationListening(conversation.listening);
    if (listening) {
      conversationBehavior.listening = listening;
    }
  }

  if (conversation.interaction) {
    const interaction = compileConversationInteraction(conversation.interaction);
    if (interaction) {
      conversationBehavior.interaction = interaction;
    }
  }

  return {
    conversationBehavior:
      Object.keys(conversationBehavior).length > 0 ? conversationBehavior : undefined,
    errors,
  };
}

function compileConversationSpeaking(
  speaking: NonNullable<ConversationBehaviorAST['speaking']>,
): ConversationSpeakingIR | undefined {
  const compiled: ConversationSpeakingIR = {};

  if (speaking.style) compiled.style = speaking.style;
  if (speaking.tone) compiled.tone = speaking.tone;
  if (speaking.emotion) compiled.emotion = speaking.emotion;
  if (speaking.pace) compiled.pace = speaking.pace;
  if (speaking.language_policy) compiled.language_policy = speaking.language_policy;
  if (speaking.fixed_language) compiled.fixed_language = speaking.fixed_language;
  if (speaking.max_sentences !== undefined) compiled.max_sentences = speaking.max_sentences;
  if (speaking.one_thing_at_a_time !== undefined) {
    compiled.one_thing_at_a_time = speaking.one_thing_at_a_time;
  }
  if (speaking.tool_lead_in) compiled.tool_lead_in = speaking.tool_lead_in;
  if (speaking.readback) {
    const readback: NonNullable<ConversationSpeakingIR['readback']> = {};
    if (speaking.readback.numbers) readback.numbers = speaking.readback.numbers;
    if (speaking.readback.codes) readback.codes = speaking.readback.codes;
    if (speaking.readback.critical_details) {
      readback.critical_details = speaking.readback.critical_details;
    }
    if (Object.keys(readback).length > 0) {
      compiled.readback = readback;
    }
  }
  if (speaking.phrases_ref) compiled.phrases_ref = speaking.phrases_ref;
  if (speaking.pronunciations_ref) compiled.pronunciations_ref = speaking.pronunciations_ref;

  if (speaking.tool_results) {
    const toolResults: NonNullable<ConversationSpeakingIR['tool_results']> = {};
    if (speaking.tool_results.style) toolResults.style = speaking.tool_results.style;
    if (speaking.tool_results.max_points !== undefined) {
      toolResults.max_points = speaking.tool_results.max_points;
    }
    if (Object.keys(toolResults).length > 0) {
      compiled.tool_results = toolResults;
    }
  }

  if (speaking.handoffs) {
    const handoffs: NonNullable<ConversationSpeakingIR['handoffs']> = {};
    if (speaking.handoffs.internal) handoffs.internal = speaking.handoffs.internal;
    if (speaking.handoffs.human) handoffs.human = speaking.handoffs.human;
    if (Object.keys(handoffs).length > 0) {
      compiled.handoffs = handoffs;
    }
  }

  return Object.keys(compiled).length > 0 ? compiled : undefined;
}

function compileConversationListening(
  listening: NonNullable<ConversationBehaviorAST['listening']>,
): ConversationListeningIR | undefined {
  const compiled: ConversationListeningIR = {};

  if (listening.barge_in) compiled.barge_in = listening.barge_in;
  if (listening.on_pause) compiled.on_pause = listening.on_pause;
  if (listening.on_overlap) compiled.on_overlap = listening.on_overlap;
  if (listening.on_unclear_audio) compiled.on_unclear_audio = listening.on_unclear_audio;
  if (listening.on_self_correction) {
    compiled.on_self_correction = listening.on_self_correction;
  }

  return Object.keys(compiled).length > 0 ? compiled : undefined;
}

function compileConversationInteraction(
  interaction: NonNullable<ConversationBehaviorAST['interaction']>,
): ConversationInteractionIR | undefined {
  const compiled: ConversationInteractionIR = {};

  if (interaction.answer_shape) compiled.answer_shape = interaction.answer_shape;
  if (interaction.detail) compiled.detail = interaction.detail;
  if (interaction.initiative) compiled.initiative = interaction.initiative;
  if (interaction.empathy) compiled.empathy = interaction.empathy;
  if (interaction.closure) compiled.closure = interaction.closure;

  if (interaction.grounding?.mode) {
    compiled.grounding = { mode: interaction.grounding.mode };
  }

  if (interaction.clarification) {
    const clarification: NonNullable<ConversationInteractionIR['clarification']> = {};
    if (interaction.clarification.mode) clarification.mode = interaction.clarification.mode;
    if (interaction.clarification.max_questions !== undefined) {
      clarification.max_questions = interaction.clarification.max_questions;
    }
    if (interaction.clarification.assume_when_low_risk !== undefined) {
      clarification.assume_when_low_risk = interaction.clarification.assume_when_low_risk;
    }
    if (Object.keys(clarification).length > 0) {
      compiled.clarification = clarification;
    }
  }

  if (interaction.confirmation) {
    const confirmation: NonNullable<ConversationInteractionIR['confirmation']> = {};
    if (interaction.confirmation.parameters) {
      confirmation.parameters = interaction.confirmation.parameters;
    }
    if (interaction.confirmation.actions) {
      confirmation.actions = interaction.confirmation.actions;
    }
    if (Object.keys(confirmation).length > 0) {
      compiled.confirmation = confirmation;
    }
  }

  if (interaction.uncertainty) {
    const uncertainty: NonNullable<ConversationInteractionIR['uncertainty']> = {};
    if (interaction.uncertainty.mode) uncertainty.mode = interaction.uncertainty.mode;
    if (interaction.uncertainty.offer_next_step !== undefined) {
      uncertainty.offer_next_step = interaction.uncertainty.offer_next_step;
    }
    if (Object.keys(uncertainty).length > 0) {
      compiled.uncertainty = uncertainty;
    }
  }

  if (interaction.repair) {
    const repair: NonNullable<ConversationInteractionIR['repair']> = {};
    if (interaction.repair.on_correction) repair.on_correction = interaction.repair.on_correction;
    if (interaction.repair.on_confusion) repair.on_confusion = interaction.repair.on_confusion;
    if (interaction.repair.on_misheard) repair.on_misheard = interaction.repair.on_misheard;
    if (interaction.repair.max_attempts !== undefined) {
      repair.max_attempts = interaction.repair.max_attempts;
    }
    if (Object.keys(repair).length > 0) {
      compiled.repair = repair;
    }
  }

  if (interaction.context) {
    const context: NonNullable<ConversationInteractionIR['context']> = {};
    if (interaction.context.avoid_reasking !== undefined) {
      context.avoid_reasking = interaction.context.avoid_reasking;
    }
    if (interaction.context.remember_recent_constraints !== undefined) {
      context.remember_recent_constraints = interaction.context.remember_recent_constraints;
    }
    if (Object.keys(context).length > 0) {
      compiled.context = context;
    }
  }

  return Object.keys(compiled).length > 0 ? compiled : undefined;
}
