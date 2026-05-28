# Feature Request: Omnichannel Session Continuity

**Status**: ready-for-jira
**Date**: 2026-03-17

---

## Jira Ticket

**Type**: Feature Request
**Priority**: High
**Labels**: `omnichannel`, `cross-channel`, `client-requirement`

**Title**: Omnichannel Session Continuity — Cross-Channel Recall and Live Transcript Sync

---

### Problem

End users interact with our agents across multiple channels — web chat, mobile chat, voice calls. Today, each channel interaction is an isolated session. When a user starts on web chat and later calls in by phone, the agent has no awareness of the previous conversation. The user has to repeat themselves, leading to a poor experience.

Additionally, there is no way for a user who is on a voice call to simultaneously view or interact with the conversation via a text-based channel.

---

### Requirements

This feature has two parts. Part 1 is the foundation; Part 2 builds on top of it.

#### Part 1: Cross-Channel Conversation Recall

**As a** user who has previously chatted with the agent on one channel (e.g., web chat or mobile chat),
**when** I later contact the agent on a different channel (e.g., voice call),
**I want** the agent to recall information from my previous session when I ask about it,
**so that** I don't have to repeat myself and the experience feels continuous.

**Preconditions:**

- The user must be identified. The platform must know it's the same person across channels. This can happen through:
  - The agent gathering identity information during the conversation (e.g., phone number, email, account number)
  - The embedding application providing a consistent user identifier across channels
  - Channel-native identification (e.g., caller ID matching a previously stored phone number)
- The agent project must have a programmable way to trigger identity linking — i.e., the agent builder can define when and how to associate a session with a known contact. This is not automatic for anonymous users.

**Expected behaviors:**

1. When the agent gathers identity information (phone, email, account number, etc.) during a session, the platform should store this and use it for future cross-channel matching
2. When a user starts a new session on a different channel, the platform should attempt to resolve them against known contacts using available identity signals
3. When a known contact starts a new session, the agent should have access to relevant context from previous sessions — not just structured data, but the ability to recall what was actually discussed
4. When the user asks something like "what did we discuss last time?" or "you told me to do X," the agent should be able to retrieve and reference the previous conversation
5. The amount of previous context available to the agent should be bounded and configurable — for example:
   - How many previous sessions to consider
   - How far back in time
   - How many messages or tokens of context to load
6. The agent builder should have control over whether cross-session recall is enabled and how it behaves

**Out of scope for Part 1:**

- Automatic identity recognition for fully anonymous users (no gathered identity signals)
- Real-time multi-channel interaction (that's Part 2)

---

#### Part 2: Live Omnichannel Transcript Sync

**As a** user who is currently on a voice call with the agent,
**when** I open the web chat widget at the same time,
**I want** to see the live transcript of the voice conversation in the chat window and be able to respond by either speaking or typing,
**so that** I have flexibility in how I interact and can reference the conversation visually.

**Preconditions:**

- The user must be identified on both channels (the platform knows it's the same person on the call and in the chat)
- A voice session must be actively in progress

**Expected behaviors:**

1. When an identified user opens the web chat while on an active voice call, the chat should detect the ongoing session and offer to show the live transcript (rather than starting a new, separate session)
2. The voice conversation transcript should appear in the chat window in real time — both the user's spoken words (transcribed) and the agent's responses
3. If the user joins the chat mid-call, they should see the conversation history up to that point (backfill)
4. The user should be able to type a response in the chat window instead of speaking — the agent treats it as part of the same conversation regardless of input channel
5. The agent's response should be delivered to both channels — spoken via voice and displayed as text in the chat
6. Each message should indicate which channel it came from (voice vs. typed) so the user has clear visual context
7. If the voice call ends, the chat session should be able to continue as a standalone text conversation
8. If the chat window is closed, the voice call should continue unaffected

---

### User Journey Example

> **Sarah** is a customer of Acme Insurance. She opens the web chat on her phone and asks the agent about her claim status. The agent looks up her claim (claim #4821) and tells her the adjuster needs photos of the damage. Sarah says she'll upload them later and ends the chat.
>
> Two days later, Sarah calls Acme's support line. The voice agent recognizes her (caller ID matches the phone number she provided during the web chat). Sarah says: _"I uploaded the photos you asked for — what's the status now?"_
>
> The agent recalls the previous web chat, knows she's referring to claim #4821 and the photo request, and checks the current status without asking Sarah to re-explain.
>
> While on the call, Sarah opens the web chat to see the transcript. She can see the agent's spoken responses as text. When the agent reads out a long reference number, Sarah can see it in the chat instead of writing it down. She types a follow-up question in the chat while still on the call, and the agent responds to both channels.

---

### Constraints and Considerations

1. **Privacy**: Cross-session recall involves retaining and surfacing conversation content. The feature should respect data retention policies and any applicable consent requirements.
2. **Performance**: Loading previous session context should not noticeably delay session startup. Consider lazy loading (recall on demand) vs. eager loading (pre-load at session start).
3. **Cost**: Injecting previous conversation context into the LLM consumes tokens. Configurable limits are essential.
4. **Channel diversity**: The solution should work across all supported channels (web, mobile, voice, SMS, WhatsApp, etc.), not just web-to-voice.
5. **Agent builder control**: Not every agent project needs recall or live sync. These should be opt-in capabilities that the builder configures.

---

### Reference

- Platform analysis: `docs/scratchpad/cross-channel-identity-and-recall.md` — documents what infrastructure already exists and what gaps remain
- Session identity design: `docs/design/SESSION_IDENTITY_DESIGN.md` — current three-tier identity model
