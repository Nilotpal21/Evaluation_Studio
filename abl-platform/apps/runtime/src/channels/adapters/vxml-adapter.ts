/**
 * VXML/IVR Channel Adapter
 *
 * Adapter for VXML-based IVR telephony platforms (Genesys, Avaya, Cisco).
 * Unlike async channels, VXML requires synchronous XML responses — the
 * telephony platform sends transcribed text via HTTP POST and expects an
 * immediate VXML 2.1 document telling it what to say/collect next.
 *
 * The synchronous route (channel-vxml.ts) calls the VXML-specific methods
 * directly; the standard sendResponse() satisfies the interface but is unused.
 */

import { DEFAULT_MESSAGES } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { coerceSessionMetadata } from '../../services/session-metadata.js';

// ---------------------------------------------------------------------------
// Request shape from telephony platform (VXML <submit> or initial call)
// ---------------------------------------------------------------------------

export interface VxmlWebhookRequest {
  callId: string;
  from?: string;
  message?: string;
  userinput?: string;
  nomatch_count?: number;
  noinput_count?: number;
  noinput?: string;
  _event?: string;
  sessionMetadata?: Record<string, unknown> | string;
}

// ---------------------------------------------------------------------------
// VXML config stored in ChannelConnection.config JSON
// ---------------------------------------------------------------------------

export interface VxmlChannelConfig {
  bargeIn?: boolean;
  timeout?: string;
  nomatchRetries?: number;
  noinputRetries?: number;
  inboundAuthToken?: string;
  publicBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VxmlAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'voice_vxml';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: false,
    supportsMedia: false,
    supportsThreading: false,
  };

  // -------------------------------------------------------------------------
  // ChannelAdapter interface — mostly unused for the sync path
  // -------------------------------------------------------------------------

  async verifyRequest(headers: Record<string, string>, _body: unknown): Promise<boolean> {
    // API-key verification is handled in the route middleware.
    // If an x-api-key header is present we consider the request verified.
    // For open dev/testing the absence of the header also passes.
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    // VXML responses are returned synchronously from the route handler —
    // this method is never called but satisfies the adapter interface.
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // VXML-specific helpers (called directly by the sync route)
  // -------------------------------------------------------------------------

  /**
   * Build a NormalizedIncomingMessage from the raw webhook body.
   */
  buildNormalizedMessage(body: VxmlWebhookRequest): NormalizedIncomingMessage {
    const callId = body.callId;
    const text = body.message || body.userinput || '';
    const sessionMetadata = coerceSessionMetadata(body.sessionMetadata);

    return {
      externalMessageId: `${callId}-${Date.now()}`,
      externalSessionKey: `vxml:${callId}`,
      text,
      metadata: {
        callId,
        from: body.from,
        nomatch_count: body.nomatch_count,
        noinput_count: body.noinput_count,
        ...(sessionMetadata ? { sessionMetadata } : {}),
      },
      timestamp: new Date(),
    };
  }

  /**
   * Determine whether this is an error/event request from the telephony platform.
   */
  isErrorEvent(body: VxmlWebhookRequest): boolean {
    return !!body._event;
  }

  /**
   * Build a full VXML 2.1 document that prompts the caller and collects input.
   */
  buildVxmlResponse(
    agentText: string,
    webhookUrl: string,
    callId: string,
    config: VxmlChannelConfig = {},
  ): string {
    const bargeIn = config.bargeIn !== false ? 'true' : 'false';
    const timeout = config.timeout ?? '5s';
    const nomatchRetries = config.nomatchRetries ?? 3;
    const noinputRetries = config.noinputRetries ?? 3;

    const promptXml = escapeXml(agentText);

    // Build nomatch handlers
    const nomatchHandlers = buildRetryHandlers('nomatch', nomatchRetries, webhookUrl, [
      DEFAULT_MESSAGES.voice_nomatch,
      "Sorry, I still didn't get that.",
    ]);

    // Build noinput handlers
    const noinputHandlers = buildRetryHandlers('noinput', noinputRetries, webhookUrl, [
      DEFAULT_MESSAGES.voice_noinput,
      'Are you still there?',
    ]);

    return `<?xml version="1.0" encoding="UTF-8"?>
<vxml version="2.1" xmlns="http://www.w3.org/2001/vxml">
  <var name="callId" expr="'${escapeXmlAttr(callId)}'"/>
  <var name="message" expr="''"/>
  <form id="main">
    <field name="userinput">
      <property name="bargein" value="${bargeIn}"/>
      <property name="timeout" value="${escapeXmlAttr(timeout)}"/>
      <prompt>${promptXml}</prompt>
      <grammar type="application/x-jsgf" mode="voice">
        <![CDATA[ #JSGF V1.0; grammar input; public <input> = /.*/ ; ]]>
      </grammar>
${nomatchHandlers}
${noinputHandlers}
      <filled>
        <assign name="message" expr="userinput"/>
        <submit next="${escapeXmlAttr(webhookUrl)}" method="post" namelist="userinput callId message"
                enctype="application/x-www-form-urlencoded"/>
      </filled>
    </field>
  </form>
  <catch event="telephone.disconnect.hangup">
    <exit/>
  </catch>
</vxml>`;
  }

  /**
   * Build a VXML document that speaks a final message and disconnects.
   */
  buildDisconnectVxml(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<vxml version="2.1" xmlns="http://www.w3.org/2001/vxml">
  <form id="goodbye">
    <block>
      <prompt>${escapeXml(message)}</prompt>
      <disconnect/>
    </block>
  </form>
</vxml>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlAttr(text: string): string {
  return escapeXml(text);
}

/**
 * Build nomatch/noinput retry handlers with a final submit on the last retry.
 */
function buildRetryHandlers(
  eventName: 'nomatch' | 'noinput',
  maxRetries: number,
  webhookUrl: string,
  prompts: string[],
): string {
  const lines: string[] = [];
  const countVar = `${eventName}_count`;

  for (let i = 1; i <= maxRetries; i++) {
    if (i < maxRetries) {
      // Intermediate retry — reprompt
      const promptText = prompts[Math.min(i - 1, prompts.length - 1)];
      lines.push(
        `      <${eventName} count="${i}"><prompt>${escapeXml(promptText)}</prompt><reprompt/></${eventName}>`,
      );
    } else {
      // Final retry — submit back to webhook with error count
      lines.push(
        `      <${eventName} count="${i}">`,
        `        <submit next="${escapeXmlAttr(webhookUrl)}" method="post" namelist="userinput callId message ${countVar}"`,
        `                enctype="application/x-www-form-urlencoded"/>`,
        `      </${eventName}>`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Build an error VXML document (for returning errors to the telephony platform).
 */
export function buildErrorVxml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<vxml version="2.1" xmlns="http://www.w3.org/2001/vxml">
  <form id="error">
    <block>
      <prompt>${escapeXml(message)}</prompt>
      <disconnect/>
    </block>
  </form>
</vxml>`;
}
