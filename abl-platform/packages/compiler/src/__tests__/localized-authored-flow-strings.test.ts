import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).toBeDefined();

  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('localized authored flow strings', () => {
  test('compiles message_key for every Phone ID prompt and follow-up in the auth step', () => {
    const agent = compileAgent(
      `
AGENT: Authentication_Agent

GOAL: "Authenticate the caller"

MESSAGES:
  ask_phone_id: "Please enter your Phone ID (4 to 15 digits)."
  clarify_phone_id: "Your Phone ID is a unique number you set up..."
  speak_to_human: "Let me connect you with an agent who can help."
  wants_enrollment: "No worries - let's get you enrolled..."
  ask_phone_id_reprompt: "Please enter your Phone ID... say 'enroll'..."

FLOW:
  ask_phone_id_reprompt

  ask_phone_id_reprompt:
    REASONING: false
    GATHER:
      - phone_id: required
        TYPE: string
        PROMPT: "Please enter your Phone ID (4 to 15 digits)."
        MESSAGE_KEY: ask_phone_id
    DIGRESSIONS:
      - INTENT: "clarify_phone_id"
        KEYWORDS: [clarify phone id]
        RESPOND: "Your Phone ID is a unique number you set up..."
        MESSAGE_KEY: clarify_phone_id
      - INTENT: "speak_to_human"
        KEYWORDS: [speak to human]
        RESPOND: "Let me connect you with an agent who can help."
        MESSAGE_KEY: speak_to_human
      - INTENT: "wants_enrollment"
        KEYWORDS: [wants enrollment]
        RESPOND: "No worries - let's get you enrolled..."
        MESSAGE_KEY: wants_enrollment
    ON_INPUT:
      - IF: phone_id == null
        RESPOND: "Please enter your Phone ID... say 'enroll'..."
        MESSAGE_KEY: ask_phone_id_reprompt
        THEN: ask_phone_id_reprompt
      - ELSE:
        THEN: COMPLETE
`,
      'Authentication_Agent',
    );

    const step = agent.flow?.definitions.ask_phone_id_reprompt;
    expect(step?.gather?.fields[0]?.message_key).toBe('ask_phone_id');
    expect(step?.digressions?.map((digression) => digression.message_key)).toEqual([
      'clarify_phone_id',
      'speak_to_human',
      'wants_enrollment',
    ]);
    expect(step?.on_input?.[0]?.message_key).toBe('ask_phone_id_reprompt');
  });
});
