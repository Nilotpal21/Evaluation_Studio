/**
 * Conversation runner — drives a single persona conversation over WebSocket.
 *
 * Opens a WS connection using buildSdkWSProtocols, sends LLM-generated user
 * turns, listens for agent responses, and ends the session when the persona
 * outputs [END_CONVERSATION] or MAX_TURNS is reached.
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import { createLogger } from '@agent-platform/shared-observability/logger';
import type {
  ConversationRunnerOpts,
  LLMClient,
  Scenario,
  Transcript,
  TranscriptMessage,
  TranscriptOutcome,
} from './types.js';
import { buildPersonaPrompt, detectEndSentinel } from './prompt-builder.js';

const DEFAULT_RUNTIME_WS_URL = 'ws://localhost:3112/ws/sdk';
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_ENDED_GRACE_MS = 30_000;

/**
 * Run a single conversation between an LLM persona and the bot.
 *
 * @param sdkToken - A fresh SDK token obtained from share-token exchange.
 * @param scenario - The scenario describing the persona.
 * @param llm - The LLM client for generating persona turns.
 * @param opts - Optional configuration (scenarioIndex, runtimeWsUrl, etc.).
 * @returns The full transcript of the conversation.
 */
export async function runConversation(
  sdkToken: string,
  scenario: Scenario,
  llm: LLMClient,
  opts?: ConversationRunnerOpts,
): Promise<Transcript> {
  const scenarioIndex = opts?.scenarioIndex ?? 0;
  const runtimeWsUrl = opts?.runtimeWsUrl || DEFAULT_RUNTIME_WS_URL;
  const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const protocolBuilder = opts?.protocolBuilder ?? buildSdkWSProtocols;

  const tag = `[s${String(scenarioIndex + 1).padStart(2, '0')}]`;
  const log = createLogger(`conversation-runner${tag}`);

  const messages: TranscriptMessage[] = [];
  const startedAt = new Date().toISOString();
  let errorMessage: string | undefined;

  return new Promise<Transcript>((resolve) => {
    const protocols = protocolBuilder(sdkToken);
    const ws = new WebSocket(runtimeWsUrl, protocols);

    let turnCount = 0;
    let waitingForResponse = false;
    let finished = false;
    let gracefulSessionEnded = false;
    let sessionId: string | undefined;
    let pendingOutcome: TranscriptOutcome = 'success';
    let sessionEndedGraceTimeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (finalOutcome: TranscriptOutcome, error?: string) => {
      if (finished) return;
      finished = true;
      errorMessage = error;
      clearTimeout(conversationTimeout);
      if (sessionEndedGraceTimeout) {
        clearTimeout(sessionEndedGraceTimeout);
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve({
        scenarioIndex,
        scenario,
        messages,
        startedAt,
        endedAt: new Date().toISOString(),
        outcome: finalOutcome,
        ...(errorMessage ? { error: errorMessage } : {}),
      });
    };

    const conversationTimeout = setTimeout(() => {
      log.warn('Conversation timed out', { sessionId, timeoutMs });
      finish('timeout', `Timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const sendEndSession = (finalOutcome: TranscriptOutcome) => {
      pendingOutcome = finalOutcome;

      if (ws.readyState !== WebSocket.OPEN) {
        finish('failed', 'Session closed before session_ended acknowledgement');
        return;
      }

      log.info('Sending end_session', { sessionId });
      ws.send(JSON.stringify({ type: 'end_session' }));

      // Grace period for session_ended ack
      sessionEndedGraceTimeout = setTimeout(() => {
        if (!finished) {
          log.warn('session_ended not received within grace period, closing', { sessionId });
          finish(
            'failed',
            'session_ended acknowledgement was not received before the socket closed',
          );
        }
      }, SESSION_ENDED_GRACE_MS);
    };

    const sendNextUserTurn = async () => {
      if (finished || waitingForResponse) return;

      if (turnCount >= maxTurns) {
        log.info('Max turns reached, ending session', { sessionId, maxTurns });
        sendEndSession('max_turns');
        return;
      }

      const history = messages.map((m) => ({ role: m.role, text: m.text }));

      let userText: string;
      try {
        const personaMessages = buildPersonaPrompt(scenario, history);
        userText = await llm.chat(personaMessages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('LLM failed mid-conversation', { sessionId, error: msg });
        finish('failed', `LLM error: ${msg}`);
        return;
      }

      userText = userText.trim();

      if (detectEndSentinel(userText)) {
        log.info('Persona ended conversation', { sessionId });
        sendEndSession('success');
        return;
      }

      turnCount++;
      const timestamp = new Date().toISOString();
      messages.push({ role: 'user', text: userText, timestamp });

      log.info(`User turn ${turnCount}/${maxTurns}`, {
        sessionId,
        preview: userText.slice(0, 60),
      });

      waitingForResponse = true;
      ws.send(
        JSON.stringify({
          type: 'chat_message',
          text: userText,
          messageId: uuidv4(),
        }),
      );
    };

    ws.on('open', () => {
      log.info('WebSocket connected', {
        intent: scenario.intent,
        targetAgent: scenario.targetAgent,
        assignedPreset: scenario.assignedPreset,
      });
    });

    ws.on('message', (raw) => {
      let data: { type: string; [key: string]: unknown };
      try {
        data = JSON.parse(raw.toString()) as { type: string; [key: string]: unknown };
      } catch {
        return;
      }

      switch (data.type) {
        case 'session_start':
          sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
          log.info('Session started', { sessionId });
          // Start the first user turn
          void sendNextUserTurn();
          break;

        case 'response_end': {
          waitingForResponse = false;
          const agentText = typeof data.fullText === 'string' ? data.fullText : '';
          const timestamp = new Date().toISOString();
          messages.push({ role: 'agent', text: agentText, timestamp });
          log.info('Agent responded', { sessionId, preview: agentText.slice(0, 60) });

          // Small delay for realism, then next turn
          setTimeout(() => void sendNextUserTurn(), 500);
          break;
        }

        case 'session_ended':
          log.info('Session ended (pipelines will fire)', { sessionId });
          gracefulSessionEnded = true;
          finish(pendingOutcome);
          break;

        case 'error': {
          const errMsg = typeof data.message === 'string' ? data.message : JSON.stringify(data);
          log.error('WebSocket error event', { sessionId, error: errMsg });
          finish('failed', errMsg);
          break;
        }

        // Ignore intermediate events
        case 'response_start':
        case 'response_chunk':
        case 'trace_event':
          break;

        default:
          break;
      }
    });

    ws.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('WebSocket connection error', { sessionId, error: msg });
      finish('failed', `WS error: ${msg}`);
    });

    ws.on('close', () => {
      if (!finished) {
        const closeError = gracefulSessionEnded
          ? undefined
          : 'WebSocket closed before session_ended acknowledgement';
        finish(gracefulSessionEnded ? pendingOutcome : 'failed', closeError);
      }
    });
  });
}
