import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';

const AUTHENTICATION_AGENT_DSL = `
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
        TYPE: phone
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
`;

const AUTHENTICATION_AGENT_WITHOUT_MESSAGE_KEYS_DSL = AUTHENTICATION_AGENT_DSL.replace(
  /\n\s+MESSAGE_KEY: [^\n]+/g,
  '',
);

const SPANISH_PHONE_ID_MESSAGES = {
  ask_phone_id: 'Ingrese su Phone ID de 4 a 15 digitos.',
  clarify_phone_id: 'Su Phone ID es un numero unico que configuro.',
  speak_to_human: 'Le conectare con un agente que puede ayudarle.',
  wants_enrollment: 'No se preocupe, vamos a inscribirle.',
  ask_phone_id_reprompt: "Ingrese su Phone ID o diga 'inscribirme'.",
};

const ENGLISH_PHONE_ID_MESSAGES = [
  'Please enter your Phone ID (4 to 15 digits).',
  'Your Phone ID is a unique number you set up...',
  'Let me connect you with an agent who can help.',
  "No worries - let's get you enrolled...",
  "Please enter your Phone ID... say 'enroll'...",
];

function createSpanishAuthSession(executor: RuntimeExecutor, dsl = AUTHENTICATION_AGENT_DSL) {
  const session = executor.createSessionFromResolved(
    compileToResolvedAgent([dsl], 'Authentication_Agent'),
  );
  const catalog = buildSessionLocalizationCatalog({
    'locale:es-ES/authentication_agent.json': JSON.stringify(SPANISH_PHONE_ID_MESSAGES),
  });
  session.data.values._locale = 'es-ES';
  storeSessionLocalizationCatalog(session.data, catalog);
  return session;
}

describe('localized authentication Phone ID scenario', () => {
  let executor: RuntimeExecutor;

  afterEach(() => {
    executor?.stopStaleReaper();
  });

  it('renders Spanish for the initial Phone ID ask and every same-step follow-up', async () => {
    executor = new RuntimeExecutor();

    const initialSession = createSpanishAuthSession(executor);
    const initialChunks: string[] = [];
    await executor.initializeSession(initialSession.id, (chunk) => initialChunks.push(chunk));
    expect(initialChunks.join('')).toContain(SPANISH_PHONE_ID_MESSAGES.ask_phone_id);

    const followUps: Array<{ message: string; expected: string }> = [
      {
        message: 'clarify phone id',
        expected: SPANISH_PHONE_ID_MESSAGES.clarify_phone_id,
      },
      {
        message: 'speak to human',
        expected: SPANISH_PHONE_ID_MESSAGES.speak_to_human,
      },
      {
        message: 'wants enrollment',
        expected: SPANISH_PHONE_ID_MESSAGES.wants_enrollment,
      },
      {
        message: 'no tengo eso',
        expected: SPANISH_PHONE_ID_MESSAGES.ask_phone_id_reprompt,
      },
    ];

    for (const followUp of followUps) {
      const session = createSpanishAuthSession(executor);
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, followUp.message, (chunk) => chunks.push(chunk));

      const output = chunks.join('');
      expect(output).toContain(followUp.expected);
      for (const englishMessage of ENGLISH_PHONE_ID_MESSAGES) {
        expect(output).not.toContain(englishMessage);
      }
    }
  });

  it('preserves authored English rendering when the Phone ID step omits message_key', async () => {
    executor = new RuntimeExecutor();
    const session = createSpanishAuthSession(
      executor,
      AUTHENTICATION_AGENT_WITHOUT_MESSAGE_KEYS_DSL,
    );

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (chunk) => chunks.push(chunk));

    expect(chunks.join('')).toContain('Please enter your Phone ID (4 to 15 digits).');
    expect(chunks.join('')).not.toContain(SPANISH_PHONE_ID_MESSAGES.ask_phone_id);
  });
});
