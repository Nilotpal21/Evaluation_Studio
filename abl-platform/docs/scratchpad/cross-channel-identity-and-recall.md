# Cross-Channel User Recognition & Conversation Recall

**Status**: exploring
**Date**: 2026-03-17
**Author**: Vishnu (via platform analysis)

---

## Scenario

A user starts chatting with an agent project via **Web SDK**. Later, they switch to a **phone call** (or any other channel). The agent should:

1. Recognize the user as the same person (automatically or through programmable logic)
2. Merge or link the contact/thread so context is unified
3. Recall information from the earlier chat session when asked

---

## What Already Exists (Platform Capabilities)

### 1. Three-Tier Identity Model -- EXISTS

The platform already has a tiered identity model (`docs/design/SESSION_IDENTITY_DESIGN.md`):

| Tier | Name           | Identity                              | Cross-Channel?         | Cross-Session Memory? |
| ---- | -------------- | ------------------------------------- | ---------------------- | --------------------- |
| 0    | Ephemeral      | None                                  | No                     | No                    |
| 1    | Channel-Bound  | Cookie, caller ID, device fingerprint | No (same channel only) | No                    |
| 2    | Contact-Linked | Verified (HMAC, OTP, OAuth, provider) | **Yes**                | **Yes**               |

**Key insight**: Cross-channel recognition only works at **Tier 2** (verified identity). This is by design -- at scale (200M sessions/day), creating Contact records for anonymous users is infeasible.

### 2. Contact Model with Multi-Identity -- EXISTS

`packages/database/src/models/contact.model.ts`

The `Contact` model already supports multiple identities:

- `identities[]` array with types: `email`, `phone`, `external`
- All identities are encrypted (AES-256-GCM) with blind index (HMAC-SHA256) for lookup
- `channelHistory[]` tracks per-channel interaction history (channelType, firstSession, lastSession, sessionCount)
- `mergedInto` field for contact merge forwarding
- `contactContext` (64KB) stores cross-session data: preferences, dataValues, lastDisposition, sessionCount

### 3. Contact Merge -- EXISTS

`apps/runtime/src/contexts/contact/use-cases/`

Full DDD implementation:

- **DetectMergeCandidates**: Finds contacts with overlapping identities
- **ExecuteMerge**: Consolidates two contacts (moves identities, channel history to primary; sets `mergedInto` on secondary)
- **ResolveOrCreateContact**: Finds existing or creates new contact by identity
- **LinkSessionToContact**: Links session to contact, updates channel history
- API routes: `POST /merge` (admin), `POST /:id/self-merge` (SDK session)

### 4. Cross-Session Contact Context -- EXISTS

When a session ends (`completed`/`escalated` disposition):

1. **Promote**: BullMQ job (`promote-contact-context`) extracts `dataValues` from session snapshot and merges into Contact's `contactContext`
2. **Pre-load**: On next session start, `InitializeSession` orchestrator loads `contactContext` into `callerContext` for tier-2+ contacts
3. **Caching**: `ContactContextService` uses Redis cache (5min TTL) + MongoDB as source of truth

### 5. Persistent Memory (FactStore) -- EXISTS

`apps/runtime/src/services/stores/mongodb-fact-store.ts`

A full key-value memory system scoped per user:

- **User scope**: `tenantId + userId + projectId` isolation
- **Project scope**: Shared across all users in a project
- **REMEMBER/RECALL DSL**: Declarative triggers -- store facts when conditions match, load facts on session start or events
- **TTL**: 90-day default (GDPR), configurable per-fact
- **10KB value limit** per fact

### 6. Conversation History Storage -- EXISTS

`packages/database/src/models/message.model.ts`

Messages are persisted to MongoDB with compound index `{ tenantId, contactId, timestamp: -1 }`.

- `GET /api/contacts/:id/history` provides cursor-paginated cross-session message history
- Only available for identified contacts (tier 2+)

### 7. Conversation Compaction -- EXISTS (disabled by default)

`apps/runtime/src/services/session/compaction-engine.ts`

When conversation approaches context window limit (80% threshold), older messages are summarized via LLM into a compact system message. Disabled by default (`SessionConfig.compactionEnabled: false`).

### 8. Session Resolution by Channel Artifact -- EXISTS

`apps/runtime/src/services/identity/session-resolver.ts`

Sessions can be resumed within the same channel via artifact-based resolution:

- Resolution key: `(tenantId, channelId, artifactHash)` in Redis
- Default resume window: 24 hours
- Strategies: `always_new`, explicit sessionId, or artifact resolution

---

## What's Missing (Gaps)

### Gap 1: No Automatic Cross-Channel Identity Linking

**Problem**: When a user chats via Web SDK and then calls via phone, there's no automatic way to link these as the same person. The system creates two separate sessions with potentially two separate contacts (or one anonymous session + one with caller ID).

**What would close it**: An identity linking mechanism that can match across channels. Options:

- **Programmatic linking**: During the web chat, the agent gathers phone/email. During the call, caller ID matches the stored phone. System auto-links.
- **Explicit linking**: User provides an account number, OTP, or reference code during the call that matches their web session.
- **SDK-driven linking**: The embedding app provides a consistent `externalId` across channels (e.g., CRM customer ID).

**Current partial support**: `ResolveOrCreateContact` already does identity-based lookup. If a Contact has `phone: +1234` from the web chat (user provided it) and then a call comes from `+1234`, the system CAN resolve to the same Contact. But this requires:

1. The web chat agent to gather and store the phone as a contact identity
2. The phone channel to extract caller ID and attempt contact resolution
3. Both to reach Tier 2 (verified identity)

### Gap 2: No Conversation Content Recall Across Sessions

**Problem**: Even when the same contact is identified, the agent cannot semantically recall what was discussed in a previous session. The `contactContext` only stores structured key-value data, not conversation content.

**What would close it**: A conversation recall mechanism. Options:

- **Simple**: Load last N messages from previous sessions via `GET /contacts/:id/history` and inject into context
- **Semantic**: Embed past conversations and use vector search for relevant retrieval (RAG over conversations)
- **Structured**: At session end, use LLM to extract key facts/decisions and store them as persistent memories (FactStore)
- **Hybrid**: Structured extraction for facts + semantic search for when the user asks "what did we discuss about X?"

**Current partial support**:

- Message history exists in MongoDB with contact-level index
- FactStore exists for structured cross-session memory
- SearchAI has vector infrastructure (Qdrant, BGE-M3 embeddings) but is document-only, not conversation-indexed
- The `REMEMBER/RECALL` DSL can store structured facts but not full conversation context
- Message model has a commented-out text index on content (line 106) suggesting this was considered

### Gap 3: No Session/Thread Merge

**Problem**: Even after contacts are merged, their sessions remain separate. There's no way to merge two sessions into one continuous thread or to present a unified conversation timeline across channels.

**What would close it**: A cross-session view or session linking mechanism:

- **Session linking**: Add `relatedSessionIds[]` to the session model so sessions can reference each other
- **Unified timeline API**: New endpoint that fetches messages across all sessions for a contact, ordered chronologically
- **Context injection**: When a new session starts for a known contact, optionally inject a summary of recent sessions

**Current partial support**:

- `GET /api/contacts/:id/history` already provides a cross-session message timeline
- Sessions have `parentId` for workflow hierarchies but not for cross-channel linking

### Gap 4: Configurable Context Window for Cross-Session Recall

**Problem**: No configuration for how much previous context to load. Loading too much wastes tokens; too little loses important context.

**What would close it**: Configuration options:

- Max previous sessions to consider (e.g., last 3 sessions)
- Max messages from previous sessions (e.g., 20 messages)
- Time window (e.g., sessions from last 7 days)
- Token budget for cross-session context (e.g., 2000 tokens)
- Compaction: Summarize previous sessions instead of raw messages

### Gap 5: Channel Type Enum Mismatch

**Problem**: The session model uses a smaller channel enum (`web`, `voice`, `sms`, etc.) than the runtime's `ChannelType` union (which includes `slack`, `msteams`, `telegram`, etc.). This could cause issues when tracking channel transitions.

**What would close it**: Align the session model's channel enum with the full `ChannelType` union, or create a mapping layer.

---

## Proposed Requirements (for team discussion)

### Requirement 1: Cross-Channel Contact Resolution Pipeline

**Priority**: High
**Effort**: Medium

Enhance the session initialization flow to attempt contact resolution across channels:

1. When a session starts on any channel, extract available identity signals (caller ID, email, external ID, SDK-provided context)
2. Query existing contacts for matching identities
3. If match found: link session to existing contact, load cross-session context
4. If no match but identity available: create new contact, store identity for future matching
5. Support programmable identity extraction via agent DSL (e.g., "after gathering account_number, link to contact")

**Acceptance criteria**:

- User chats via web SDK, provides email -> contact created with email identity
- User later calls from phone -> caller ID extracted -> if phone matches contact identity -> same contact resolved
- Agent DSL supports `LINK_IDENTITY` instruction to programmatically add identities mid-session
- Self-merge API works from SDK sessions (already exists, needs wiring)

### Requirement 2: Cross-Session Conversation Recall

**Priority**: High
**Effort**: High

Enable agents to recall previous conversation content for identified contacts:

1. **Structured recall** (Phase 1): At session end, use LLM to extract key facts, decisions, and action items. Store as persistent facts in FactStore with `conversation_summary` domain prefix. On next session start, load and inject as context.

2. **Message history recall** (Phase 2): New built-in tool `recall_history` that:
   - Queries `messages` collection for the contact's previous sessions
   - Applies configurable limits: max sessions (default: 3), max messages (default: 20), time window (default: 30 days)
   - Returns formatted conversation snippets with session metadata (channel, date, disposition)
   - Enable the text index on messages collection (currently commented out)

3. **Semantic recall** (Phase 3, optional): Index conversation chunks in vector store for semantic retrieval when user asks "what did we discuss about X?"

**Configuration** (agent DSL or project settings):

```yaml
cross_session:
  recall_enabled: true
  max_previous_sessions: 3
  max_messages_per_session: 20
  time_window_days: 30
  token_budget: 2000
  auto_summarize_on_end: true
  summary_model: 'gpt-4o-mini'
```

**Acceptance criteria**:

- User asks "what was my issue last time?" -> agent retrieves summary from previous session
- User asks "you told me to do X last week" -> agent can find the specific message
- Context injection is bounded by configurable limits
- Works across channels (web -> phone -> web)

### Requirement 3: Unified Contact Timeline API

**Priority**: Medium
**Effort**: Low

Enhance existing `GET /api/contacts/:id/history` to:

- Include session metadata per message group (channel type, agent name, disposition, duration)
- Support filtering by channel type
- Support filtering by date range
- Return session boundaries clearly for UI rendering

This API already exists but needs enrichment for cross-channel visibility.

### Requirement 4: Agent-Driven Identity Gathering

**Priority**: Medium
**Effort**: Medium

Add DSL support for agents to programmatically drive identity resolution:

```
GATHER identity_verification:
  FIELD account_number TYPE string REQUIRED
  FIELD email TYPE email OPTIONAL

ON COMPLETE:
  LINK_IDENTITY email=$email
  LINK_IDENTITY external=account:$account_number
```

When `LINK_IDENTITY` executes:

1. Find or create contact with the provided identity
2. If session already linked to a different contact -> trigger merge evaluation
3. Upgrade session identity tier if verification method warrants it

### Requirement 5: Session Channel Tracking

**Priority**: Low
**Effort**: Low

Ensure `channelHistory[]` on the session model is actually populated:

- Record channel transitions within a session (e.g., web_chat -> voice escalation)
- Align channel enum between session model and runtime ChannelType
- Expose channel history in session metadata API

---

## What Works Today (End-to-End)

Even without new development, the following scenario **already works** if configured correctly:

1. **Web SDK chat**: User chats, agent gathers email via GATHER. Session ends. Contact created with email identity. `promote-contact-context` job fires, stores dataValues on contact.
2. **Phone call**: User calls. If the phone system provides caller ID AND the contact has a matching phone identity, the system resolves to the same contact. `InitializeSession` loads `contactContext` with dataValues from previous session.
3. **Agent uses dataValues**: The agent can reference `callerContext.contactContext.dataValues.email` or any other promoted values.

**What doesn't work today**: The agent cannot say "you mentioned X in your last chat" because raw conversation content is not loaded -- only structured dataValues are promoted.

---

## Open Questions

1. **Privacy**: Should cross-session recall require explicit user consent? Some jurisdictions may require opt-in for conversation history retention beyond the immediate session.
2. **Data retention**: How long should conversation content be available for recall? The current message TTL and GDPR compliance may constrain this.
3. **Performance**: Loading previous session messages adds latency to session initialization. Should this be lazy (loaded on first recall request) or eager (loaded at session start)?
4. **Token cost**: Injecting previous session context consumes LLM tokens. Should there be a cost-aware policy (e.g., only recall if the model has budget)?
5. **Multi-tenant**: Should cross-session recall work across projects within the same tenant, or only within the same project?
6. **Agent opt-in**: Should recall be a per-agent configuration, or a project-wide setting? Some agents (e.g., FAQ bot) may not need recall.
