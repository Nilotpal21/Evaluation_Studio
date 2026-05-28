# Saludsa Production Port — Unimplemented Gaps

Items that could not be fully implemented in the ABL DSL port. Each gap documents the original Kore.ai behavior, why it can't be ported, and the recommended path forward.

## 1. Contact Center Adapter (In-Flight)

**Original:** Kore.ai ContactCenter API (CC_streamId, CC_accountId) routes ESCALATE events to human agent queues (WhatsAppSAC, Voz_Emergencias, Chat Portal SAC, etc.).

**Current state:** ESCALATE events carry the full context (queueName, reason, ticketId, conversationSummary, conversationHistory, externalPhoneNumber, businessUnit, sacMessage, customerName, customerDetails, etc.) but the actual CC adapter that calls the Kore.ai ContactCenter API is being built separately.

**Impact:** Agents correctly trigger ESCALATE with all required context. The handoff to a human agent will not work until the CC adapter is connected.

**Path forward:** CC adapter integration is in-flight. Once connected, ESCALATE events will route to the correct queue.

## 2. Channel Adapters

**Original:** Kore.ai XO Bot handles WhatsApp (via Infobip), Voice (SIP), Web widget, iOS/Android SDK integration.

**Current state:** ABL agents reference session.channel for channel-aware behavior, but the actual channel adapters that receive webhook/API calls and normalize them to ABL session context are not part of this port.

**Impact:** Agents have correct channel branching logic. They will work correctly when channel adapters feed them the right session.channel, session.phoneNumber, etc.

**Path forward:** Channel adapter implementation is a separate platform infrastructure effort.

## 3. SendMessageWhatsapp (Direct Infobip API)

**Original:** The SendMessageWhatsapp code tool calls Infobip API (l3wl15.api.infobip.com/whatsapp/1/message/interactive/url-button) to send WhatsApp interactive button messages for Doctor Home Visit.

**Current state:** The Transfer_Services agent's DOCTORHOMEVISIT flow responds with the redirect text, but cannot send the actual WhatsApp interactive button. The interactive button delivery requires the WhatsApp channel adapter.

**Impact:** Doctor Home Visit users on WhatsApp will see a text message with the redirect info instead of a clickable interactive button.

**Path forward:** Implement in the WhatsApp channel adapter. When the agent responds with a DOCTORHOMEVISIT message, the adapter should convert it to a WhatsApp interactive URL button message via Infobip/Twilio.

## 4. Pre-Processor Auto-Validation for Web/iOS/Android

**Original:** Every Kore.ai agent has a JavaScript pre-processor that auto-validates digital channel users using metadata.identificacion_app_web (the user's cedula from the app login).

**Current state:** ABL agents check session.channel and skip validation for digital channels. However, the auto-validation (calling POST /validateUser with the pre-authenticated cedula) should be done by the channel adapter.

**Impact:** Digital channel users will have session.userValidation set by the channel adapter, not by the agent. The agent's skip-validation logic works correctly.

**Path forward:** The Web/iOS/Android channel adapter should call POST /validateUser with session.identificacion_app_web at session start and set session.userValidation = true, session.userRole, etc.

## 5. PII Masking

**Original:** The Password Reset agent masks email and phone in responses (e.g., t***@gmail.com, +593***5678). Kore.ai has built-in PII configuration.

**Current state:** ABL has no built-in PII detection or masking. The Password Reset agent's PERSONA instructs the LLM to mask sensitive data, but this is not enforced at the platform level.

**Impact:** The LLM will likely comply with masking instructions, but there is no guarantee.

**Path forward:** Consider implementing a GUARDRAILS block with output checks for PII patterns, or add platform-level PII masking in the ABL runtime.

## 6. Workflow Tools

**Original:** Two Kore.ai WORKFLOW tools: UpdateTicketTest (test tool, omitted) and validateExpDental (mapped to validarElegibilidadTarea with codigoTarea: "Transferencia_Dental").

**Current state:** Both have production-equivalent implementations. No gap.

## 7. Voice-Specific Behavior

**Original:** Voice channel has DTMF input, TTS responses, call transfer (SIP), Provider role immediate transfer, voice-specific menu substructure.

**Current state:** Agents include voice-specific FLOW branches but actual TTS, DTMF, and call transfer require the Voice channel adapter.

**Impact:** Voice branches exist in agent logic but won't execute until the Voice adapter is connected.

**Path forward:** Implement Voice channel adapter with TTS/STT, DTMF, and SIP call transfer capabilities.

## 8. Content Variables

**Original:** Kore.ai global content variable mcpServer for tool prefix instruction.

**Current state:** In ABL, tool naming is handled by tool registry configuration. No gap.
