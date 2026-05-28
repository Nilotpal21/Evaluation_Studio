# Feature: Conversation Behavior

**Doc Type**: SUB-FEATURE
**Parent Feature**: [ABL Language](../abl-language.md) / [Voice Capabilities](../voice-capabilities.md) / [Channels](../channels.md)
**Status**: PLANNED
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `integrations`, `governance`
**Package(s)**: `packages/core`, `packages/compiler`, `apps/runtime`, `apps/studio`, `packages/project-io`, `packages/shared-kernel`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/conversation-behavior.md](../../testing/sub-features/conversation-behavior.md)
**Last Updated**: 2026-04-21

---

## 1. Introduction / Overview

### Problem Statement

Authors need a clear way to describe how an agent should sound, how it should handle interruptions and unclear input, and how it should cooperate across turns. Today those concerns are spread across several platform surfaces:

- `PERSONA` and agent identity shape who the agent is
- `VOICE:` and execution voice settings shape acoustic rendering
- behavior profiles shape conditional overrides
- runtime interaction context resolves language, locale, and timezone
- project localization assets own locale-specific copy
- channel behavior contracts own transport-specific capability limits

Each of those seams is valid, but there is no single authoring model that tells an agent designer where conversational behavior belongs. That makes voice-first design harder, creates overlap between style and runtime behavior, and leaves Studio without one coherent mental model for high-quality conversation authoring.

### Goal Statement

Introduce **Conversation Behavior** as the canonical authoring model for conversational style and cooperative turn behavior. The feature gives authors a stable `speaking` / `listening` / `interaction` model, keeps that model inside ABL and behavior profiles, and compiles it into the existing platform seams that already own persona, localization, acoustic voice, and channel transport.

### Summary

Conversation Behavior is the feature that makes the platform's conversation design contract explicit.

- `speaking` describes how the agent packages and delivers output
- `listening` describes how a realtime voice agent yields, waits, and recovers from audio-level breakdowns
- `interaction` describes how the agent cooperates across turns through grounding, clarification, confirmation, repair, context, and closure

The feature is intentionally broader than "voice style" and narrower than "agent identity." It is about observable conversational behavior, not character design and not provider-specific audio configuration.

### Terminology & Ownership

| Concern                    | Meaning                                                       | Canonical Owner                             |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| Persona / identity         | Who the agent is, including role and character                | `PERSONA` / agent identity                  |
| Conversation Behavior      | How the agent speaks, listens, and cooperates                 | `CONVERSATION:` on agent / behavior profile |
| Acoustic voice             | TTS provider, `voice_id`, speed, SSML, voice instructions     | existing `VOICE:` / execution voice config  |
| Interaction context        | Resolved language, locale, timezone for a turn                | canonical `InteractionContext`              |
| Locale-specific phrases    | Localized wording, pronunciation assets, semantic phrase sets | project localization / vocabulary assets    |
| Channel transport behavior | What a channel can actually support                           | runtime channel behavior contract           |

---

## 2. Scope

### Goals

- Define a canonical Conversation Behavior model with three stable groups: `speaking`, `listening`, and `interaction`.
- Make the model ABL-native so it can be authored on agents and behavior profiles instead of as a separate standalone file type.
- Separate conversational behavior from identity, acoustic voice, localization, and runtime transport ownership.
- Support voice-first behavior without making the feature voice-only; `interaction` must apply across text and voice.
- Define deterministic precedence across base agent behavior, behavior-profile overrides, interaction context, channel capability gating, and safety/runtime rules.
- Support locale-aware phrase and pronunciation references through project-owned assets instead of per-agent copy duplication.
- Keep the initial launch subset small enough to be testable while leaving room for advanced fields later.

### Non-Goals (Out of Scope)

- Replacing `PERSONA`, agent identity, or a future project brand voice system.
- Replacing existing `VOICE:` ownership for provider selection, `voice_id`, speed, SSML, or acoustic rendering.
- Creating a new standalone persisted conversation-document type outside ABL and behavior profiles.
- Introducing a new telephony control plane for DTMF collection, transfer gateways, IVR menus, or provider VAD tuning.
- Shipping unrestricted adaptive or personality-style self-modification in phase 1.
- Treating phrase banks as the long-term storage location for project localization content.

---

## 3. User Stories

1. As an **agent author**, I want one place to define how my agent speaks, listens, and guides the user so I do not have to guess whether a setting belongs in persona, voice config, behavior profiles, or localization.
2. As a **voice designer**, I want interruption, repair, confirmation, and turn packaging to be first-class authoring concepts so the voice experience is not just "chat output read aloud."
3. As a **localization owner**, I want phrase and pronunciation content referenced from project assets so I can update language-specific copy in one place instead of duplicating it across many agents.
4. As a **Studio user**, I want structured UI and raw ABL to round-trip the same Conversation Behavior model so advanced editing and guided editing stay aligned.
5. As a **runtime engineer**, I want one resolved conversation-behavior view per turn so prompt building, repair logic, and channel delivery can all explain why the agent behaved a certain way.
6. As a **platform maintainer**, I want clear ownership boundaries and validation so the feature can grow without overlapping existing ABL, localization, or voice constructs.

---

## 4. Functional Requirements

1. **FR-1**: The system must define a canonical Conversation Behavior model with the stable top-level groups `speaking`, `listening`, and `interaction`.
2. **FR-2**: The system must support Conversation Behavior at agent scope and behavior-profile scope inside ABL and corresponding Studio authoring surfaces.
3. **FR-3**: The system must keep identity, acoustic voice, localization, and runtime channel ownership separate from Conversation Behavior and reject configurations that cross those boundaries.
4. **FR-4**: The system must resolve output language, locale, and timezone through canonical `InteractionContext` semantics and expose authored language behavior as policy, not as an isolated free-form voice setting.
5. **FR-5**: The system must support the phase-1 launch field set defined in this spec for `speaking`, `listening`, and `interaction`, with stable naming and grouping across future phases.
6. **FR-6**: The system must allow phrase and pronunciation references to project-owned locale assets or semantic assets instead of requiring inline duplication in every agent or profile.
7. **FR-7**: The system must define deterministic precedence across base Conversation Behavior, behavior-profile overrides, interaction context, runtime safety rules, and channel capability gating.
8. **FR-8**: The system must capability-gate voice-only or transport-specific behavior against channel families so unsupported policies fail closed instead of silently drifting.
9. **FR-9**: The compiler must validate unsupported field combinations, unresolved asset references, ownership conflicts, and unknown channel-family overrides before deployment.
10. **FR-10**: Runtime execution must resolve one effective Conversation Behavior view per turn and expose trace/debug evidence for the sources that contributed to it.
11. **FR-11**: Studio, import/export, and project I/O must round-trip Conversation Behavior authoring and referenced assets without losing structure.
12. **FR-12**: The model must remain extensible for future advanced fields without changing the core mental model of `speaking`, `listening`, and `interaction`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project assets may be referenced for phrases and pronunciations.                          |
| Agent lifecycle            | PRIMARY      | Agent authoring semantics and behavior-profile semantics are extended.                    |
| Customer experience        | PRIMARY      | Response shape, repair, confirmation, and turn-taking affect end-user behavior directly.  |
| Integrations / channels    | PRIMARY      | Runtime capability gating varies by channel family and voice surface.                     |
| Observability / tracing    | SECONDARY    | Resolved behavior needs runtime trace/debug visibility.                                   |
| Governance / controls      | PRIMARY      | Ownership boundaries and fail-closed validation are core to the design.                   |
| Enterprise / compliance    | SECONDARY    | Clear confirmation, repair, and uncertainty behavior reduce ambiguous agent actions.      |
| Admin / operator workflows | SECONDARY    | Operators need clearer diagnostics for why a voice or chat session behaved a certain way. |

### Related Feature Integration Matrix

| Related Feature                                                   | Relationship Type | Why It Matters                                                                             | Key Touchpoints                                                    | Current State |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------- |
| [ABL Language](../abl-language.md)                                | extends           | Conversation Behavior is authored in ABL and compiled with the rest of the agent contract. | parser, AST, compiler, docs                                        | STABLE        |
| [Voice Capabilities](../voice-capabilities.md)                    | extends           | Acoustic voice rendering remains separate but must cooperate with conversational behavior. | `VoiceConfigIR`, TTS/realtime voice surfaces                       | ALPHA         |
| [Channels](../channels.md)                                        | depends on        | Channel families determine which listening and transport-aware policies are valid.         | channel manifests, behavior profiles, runtime capability contracts | ALPHA         |
| [Localized Interaction Context](localized-interaction-context.md) | depends on        | Language/locale/timezone resolution must remain canonical at runtime.                      | `InteractionContext`, session state, runtime ingress               | PLANNED       |
| [Localization Asset Management](localization-asset-management.md) | shares data with  | Phrase and pronunciation content should be referenced from project assets.                 | `locales/<locale>/<asset>.json`, project asset validation          | PLANNED       |
| [Agent Development (Studio)](../agent-development-studio.md)      | configured by     | Studio must provide structured editing and raw ABL round-trip for the feature.             | profile editor, behavior section, serializer                       | STABLE        |
| [Project Import & Export](../project-import-export.md)            | shares data with  | Conversation Behavior and its asset references must survive bundle/export round-trip.      | project I/O, dependency extractor, validators                      | STABLE        |

---

## 6. Design Considerations

### 6.1 Design Principles

- **Cooperation over theater**: the goal is not to make the agent "sound human"; the goal is to make it brief, grounded, repairable, and easy to work with.
- **Voice is not text read aloud**: spoken turns must be short, one-thing-at-a-time, and easy to recover from.
- **Listening is first-class**: interruptions, pauses, overlap, and unclear audio deserve their own authoring model.
- **Grounding and repair are central**: high-quality conversation depends on showing understanding, asking clarifying questions only when useful, and recovering quickly from mistakes.
- **Confirmation must be nuanced**: confirming understanding and confirming actions are related but not the same thing.
- **Examples are not scripts**: phrase banks can help shape tone, but they should not hard-code repetitive behavior.

### 6.2 Canonical Model

Conceptually, Conversation Behavior has four conversational layers, but only three belong to this feature:

```yaml
identity:
  persona: ...
speaking: ...
listening: ...
interaction: ...
```

`identity` is shown only to clarify the boundary. Identity already exists and remains the owner of who the agent is. Conversation Behavior owns how the agent behaves in conversation.

### 6.3 Proposed ABL Surface

The conceptual model above is authored in-platform as an ABL-native `CONVERSATION:` block:

```yaml
CONVERSATION:
  SPEAKING:
    STYLE: 'warm and concise'
    TONE: 'reassuring'
    PACE: steady
    MAX_SENTENCES: 2
    ONE_THING_AT_A_TIME: true
    TOOL_LEAD_IN: brief
  LISTENING:
    BARGE_IN: allow
    ON_PAUSE: wait_briefly
    ON_OVERLAP: stop_and_listen
    ON_UNCLEAR_AUDIO: ask_to_repeat_or_confirm
  INTERACTION:
    ANSWER_SHAPE: answer_first
    DETAIL: expandable
    GROUNDING:
      MODE: acknowledge_then_answer
    CLARIFICATION:
      MODE: ask_only_when_blocked
    CONFIRMATION:
      ACTIONS: before_sensitive_actions
```

The same shape can appear at behavior-profile scope to create contextual or channel-family overrides:

```yaml
BEHAVIOR_PROFILE: voice_core
PRIORITY: 20
WHEN: channel.behavior_profile == "voice_core"

CONVERSATION:
  SPEAKING:
    MAX_SENTENCES: 2
    TOOL_LEAD_IN: brief
  LISTENING:
    BARGE_IN: allow
    ON_OVERLAP: stop_and_listen
```

### 6.4 Naming Decisions

| Preferred Term          | Why This Is the Canonical Term                                                         | Terms Explicitly Avoided                                 |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Conversation Behavior` | Describes the feature without implying a second language or a subjective quality score | `Conversation Quality DSL`, `conversation policy engine` |
| `speaking`              | Natural author-facing name for spoken delivery and output packaging                    | `speech_behavior`, `voice_behavior`, `voice`             |
| `listening`             | Matches the realtime voice surface authors actually care about                         | `turn_manager`, `VAD policy`, `audio policy`             |
| `interaction`           | Covers multi-turn cooperation without sounding implementation-heavy                    | `dialog_policy`, `orchestration`, `behavior_policy`      |
| `tool_lead_in`          | Clear and useful for pre-tool speech                                                   | `filler`, `pre_tool_filler`                              |
| `assumption_handling`   | Clearer than a research term for false or unverified user assumptions                  | `presuppositions`                                        |
| `language_policy`       | Future-ready because it composes with `InteractionContext`                             | `speaking.language` as a standalone source of truth      |

### 6.5 Ownership Matrix

| Concern                                                     | Owned By                                 | Why                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Persona, role, character                                    | `PERSONA` / identity                     | These define who the agent is, not how it packages turns.                           |
| TTS provider, `voice_id`, speed, SSML                       | `VOICE:` / execution voice config        | These are rendering concerns and already map to provider-specific runtime behavior. |
| Language, locale, timezone resolution                       | canonical `InteractionContext`           | These are per-turn execution inputs and may vary by message, session, or channel.   |
| Locale-specific phrases and pronunciations                  | project localization / vocabulary assets | These are shared assets that should not be duplicated per agent.                    |
| Interruptibility, repair, clarification, grounding, closure | Conversation Behavior                    | These are the core observable conversation behaviors this feature exists to author. |
| Channel-specific support limits                             | runtime channel behavior contract        | Capability differences belong to the channel layer, not to agent authoring.         |

### 6.6 Field Catalog: `speaking`

`speaking` owns spoken delivery and output packaging. It does not own identity and it does not own provider-specific TTS selection.

| Field                 | Type                              | Purpose                                                                                 | Phase / Notes |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------- | ------------- |
| `style`               | free-form string                  | Overall delivery direction such as "warm and concise" or "clear and practical"          | Launch        |
| `tone`                | free-form or small controlled set | Interpersonal tone without redefining persona                                           | Launch        |
| `emotion`             | free-form string                  | Baseline emotional color of delivery, separate from user-state empathy                  | Launch        |
| `pace`                | enum                              | Controls how quickly and deliberately the agent sounds                                  | Launch        |
| `variety`             | enum                              | Controls repetition vs natural variation in stock phrases                               | Advanced      |
| `language_policy`     | enum / BCP-47-aware policy        | Expresses how speaking behavior follows `InteractionContext` or a fixed language policy | Launch        |
| `max_sentences`       | integer                           | Keeps spoken turns brief and recoverable                                                | Launch        |
| `one_thing_at_a_time` | boolean                           | Limits each turn to one question or one missing item                                    | Launch        |
| `tool_lead_in`        | enum                              | Controls whether the agent gives a short pre-tool utterance                             | Launch        |
| `tool_results`        | structured object                 | Shapes how tool output is summarized, ordered, and chunked                              | Launch        |
| `readback`            | structured object                 | Controls how numbers, codes, and critical details are spoken back                       | Launch        |
| `pronunciations_ref`  | asset reference                   | References project-owned pronunciation or vocabulary assets                             | Launch        |
| `handoffs`            | structured object                 | Controls whether internal and human handoffs are silent, brief, or explicit             | Launch        |
| `phrases_ref`         | asset reference                   | References phrase examples for acknowledgements, clarifiers, closers, and tool lead-ins | Launch        |

### 6.7 Field Catalog: `listening`

`listening` is the realtime voice layer. Text-only agents may omit it.

| Field                | Type | Purpose                                                                      | Phase / Notes                                  |
| -------------------- | ---- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `barge_in`           | enum | Controls whether the user may interrupt while the agent is speaking          | Launch                                         |
| `backchannels`       | enum | Controls lightweight listening cues during long user turns                   | Advanced                                       |
| `on_pause`           | enum | Defines how long the agent waits before assuming a user is finished          | Launch                                         |
| `on_overlap`         | enum | Defines how the agent reacts to simultaneous speech                          | Launch                                         |
| `on_unclear_audio`   | enum | Defines recovery behavior for noisy, partial, or unintelligible audio        | Launch                                         |
| `on_self_correction` | enum | Defines how the agent handles corrections like "Tuesday, actually Wednesday" | Launch                                         |
| `use_audio_cues`     | enum | Controls whether nonverbal audio cues may influence conversational behavior  | Future / gated by channel and provider support |

### 6.8 Field Catalog: `interaction`

`interaction` owns how the agent cooperates across turns in both voice and text.

| Field                 | Type              | Purpose                                                                              | Phase / Notes |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------ | ------------- |
| `answer_shape`        | enum              | Controls the default structure of answers                                            | Launch        |
| `detail`              | enum              | Controls how much detail is given before the user asks for more                      | Launch        |
| `initiative`          | enum              | Controls how much the agent drives the next step                                     | Launch        |
| `grounding`           | structured object | Controls how the agent shows it understood the user's goal                           | Launch        |
| `clarification`       | structured object | Controls when the agent asks a clarifying question and how many                      | Launch        |
| `confirmation`        | structured object | Separates confirmation of understood parameters from confirmation of actions         | Launch        |
| `uncertainty`         | structured object | Controls how the agent expresses uncertainty and offers next steps                   | Launch        |
| `assumption_handling` | enum              | Controls how the agent handles false or unverified user assumptions                  | Launch        |
| `empathy`             | enum              | Controls when the agent acknowledges user emotion                                    | Launch        |
| `guidance`            | structured object | Controls whether the agent suggests what the user can do next                        | Launch        |
| `context`             | structured object | Controls continuity, avoiding re-asking, and summarizing progress                    | Launch        |
| `closure`             | enum              | Controls how the agent makes completion clear                                        | Launch        |
| `repair`              | structured object | Controls how the agent responds to correction, confusion, and mishearing             | Launch        |
| `failure_recovery`    | structured object | Controls what happens after repeated no-input or repeated no-match situations        | Launch        |
| `adaptation`          | structured object | Future hook for expertise-aware or detail-aware adaptation                           | Advanced      |
| `flow_mode`           | enum              | Optional agenda style for tutoring, troubleshooting, exploration, or task completion | Advanced      |

### 6.9 Typed vs Free-Form Guidance

| Kind                             | Examples                                                                                      | Why                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Free-form expressive text        | `style`, `tone`, `emotion`, phrase examples                                                   | These are author taste and texture, not strict runtime switches.             |
| Typed enums / booleans / numbers | `tool_lead_in`, `max_sentences`, `barge_in`, `answer_shape`, `detail`, `closure`              | These need predictable, testable behavior across compile and runtime.        |
| Small structured objects         | `tool_results`, `readback`, `grounding`, `clarification`, `confirmation`, `repair`, `context` | These keep related controls together without making the model deeply nested. |

### 6.10 Phase-1 Launch Subset

The core launch should start with the smallest field set that still gives authors meaningful control over voice and text behavior:

```yaml
speaking:
  style: 'warm and concise'
  tone: 'reassuring'
  emotion: 'calm'
  pace: steady
  language_policy: interaction_context
  max_sentences: 2
  one_thing_at_a_time: true
  tool_lead_in: brief
  tool_results:
    style: top_option_first
    max_points: 2
  handoffs:
    internal: silent
    human: explicit
listening:
  barge_in: allow
  on_pause: wait_briefly
  on_overlap: stop_and_listen
  on_unclear_audio: ask_to_repeat_or_confirm
  on_self_correction: follow_latest_intent
interaction:
  answer_shape: answer_first
  detail: expandable
  initiative: guided
  grounding:
    mode: acknowledge_then_answer
  clarification:
    mode: ask_only_when_blocked
    max_questions: 1
    assume_when_low_risk: true
  confirmation:
    parameters: when_ambiguous
    actions: before_sensitive_actions
  uncertainty:
    mode: say_when_unsure
    offer_next_step: true
  empathy: acknowledge_when_emotional
  repair:
    on_correction: accept_and_update
    on_confusion: rephrase_briefly
    on_misheard: confirm_best_guess
    max_attempts: 2
  context:
    avoid_reasking: true
    remember_recent_constraints: true
  closure: summarize_outcome
```

### 6.11 Deferred / Advanced Fields

These fields fit the model but should ship only when runtime support and evaluation coverage are ready:

- `speaking.variety`
- `listening.backchannels`
- `listening.use_audio_cues`
- `interaction.adaptation`
- `interaction.flow_mode`
- dedicated `multimodal` extensions

---

## 7. Technical Considerations

### Existing Seams This Feature Reuses

| Existing Seam                                                   | Why It Matters                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                        | Natural home for new AST types and agent/profile authoring support                                      |
| `packages/core/src/parser/agent-based-parser.ts`                | Existing parser already handles nested voice/profile constructs and should add `CONVERSATION:` support  |
| `packages/compiler/src/platform/ir/schema.ts`                   | Canonical place to introduce `ConversationBehaviorIR` and attach it to agent/profile IR                 |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Existing profile compiler already handles conditional behavior overrides and is the right lowering seam |
| `apps/runtime/src/services/execution/profile-resolver.ts`       | Existing effective-config merge point where active behavior profiles already resolve                    |
| `packages/shared-kernel/src/types/index.ts`                     | Canonical home of `InteractionContext` which must remain authoritative for language/locale/timezone     |
| `apps/runtime/src/channels/channel-behavior-contract.ts`        | Existing capability model that should gate voice-only or transport-dependent behavior                   |
| `apps/studio/src/lib/abl-serializers.ts` and authoring stores   | Existing raw ABL and structured authoring round-trip surface                                            |
| `packages/project-io`                                           | Existing import/export validation and dependency extraction surface for asset references                |

### Current Gaps the Feature Must Account For

- `VoiceConfigAST` and `VoiceConfigIR` already include provider, `voiceId` / `voice_id`, and `speed`, but `compile-behavior-profile.ts` still only forwards `ssml`, `instructions`, and `plain_text`. Conversation Behavior must land on top of a consistent voice/profile ownership story.
- Runtime profile resolution already merges instructions, tools, voice, response rules, and gather overrides, but it does not yet resolve a first-class conversation-behavior object.
- Channel behavior contracts already model rich-content and voice config differences, but not all higher-level conversation policies are yet wired as capability decisions.
- Localization asset management exists, but phrase/pronunciation references for conversational behavior are not yet a first-class asset contract.

### Design Decisions That Make the Feature Future-Ready

- The feature is modeled as an **authoring layer**, not as a second runtime truth.
- `language_policy` composes with `InteractionContext` instead of competing with it.
- locale-specific phrasing is **referenced**, not copied into every agent or profile.
- channel adaptation is expressed through **behavior profiles and channel families**, not through provider-specific fields on the authoring model.
- advanced fields are explicitly separated from the launch subset so the model can grow without destabilizing the core contract.

---

## 8. How to Consume

### Studio UI

Conversation Behavior should appear in existing authoring contexts rather than as a separate product module:

- **Agent authoring**: baseline `CONVERSATION:` behavior on the agent detail page
- **Behavior profile authoring**: contextual overrides in the existing profile editor
- **Localization authoring**: phrase and pronunciation assets managed through project localization surfaces
- **Raw ABL**: the same model should serialize to and from ABL without loss

### Surface Semantics Matrix

| Asset / Entity Type           | Source of Truth / Ownership                | Design-Time Surface(s)                          | Editable or Read-Only?      | Consumer Reference / Binding Model                     | Runtime Materialization / Resolution                                           | Notes / Unsupported State                |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------- |
| Conversation Behavior block   | agent DSL / behavior-profile DSL           | agent editor, profile editor, raw ABL           | Editable                    | Inline `CONVERSATION:` block                           | Resolved from base agent + active profiles                                     | Primary authoring contract               |
| Channel-family override       | behavior profile / agent DSL               | same authoring surfaces                         | Editable                    | profile conditions and optional channel-family scoping | Applied only when the current channel family matches and supports the behavior | Unknown families are compile errors      |
| Phrase asset reference        | project localization assets                | localization settings, raw ABL                  | Editable                    | stable asset reference                                 | Resolved per locale at compile/runtime                                         | Inline phrase duplication is discouraged |
| Pronunciation asset reference | localization or vocabulary assets          | raw ABL first; managed UI later                 | Editable                    | stable asset reference                                 | Consumed only where runtime/provider supports pronunciation hints              | Dedicated lexicon UX can ship later      |
| Acoustic voice config         | existing `VOICE:` / execution voice config | existing voice editors and raw ABL              | Editable                    | existing voice config fields                           | Consumed by TTS or realtime voice runtime                                      | Not re-owned by Conversation Behavior    |
| Interaction context           | runtime session state                      | not directly edited in Conversation Behavior UI | Read-only from this feature | runtime-derived language/locale/timezone               | Feeds `language_policy` and asset locale resolution                            | Runtime owner remains canonical          |
| Channel capability contract   | platform-owned registry                    | diagnostics and help text only                  | Read-only                   | channel family lookup                                  | gates listening / runtime-only behavior                                        | Not tenant-editable                      |

### Design-Time vs Runtime Behavior

Design time:

1. Authors define baseline Conversation Behavior on agents.
2. Authors define contextual overrides on behavior profiles.
3. Authors reference project-owned phrase or pronunciation assets.
4. Preview and compile validate ownership boundaries, asset references, and channel-family compatibility.

Runtime:

1. Runtime resolves canonical `InteractionContext` for the turn.
2. Runtime matches active behavior profiles.
3. Runtime merges base Conversation Behavior with matching overrides and runtime policy inputs.
4. Runtime capability-gates voice-only or transport-sensitive behavior against the current channel family.
5. Prompt building, gather/repair logic, and output delivery consume the resolved result.
6. Trace/debug surfaces expose the source chain and capability decisions.

### API (Runtime)

Phase 1 does not require a new public runtime endpoint. Existing execution surfaces consume the resolved Conversation Behavior view.

| Method         | Path                                 | Purpose                                                            |
| -------------- | ------------------------------------ | ------------------------------------------------------------------ |
| POST           | existing chat/agent execution routes | Apply resolved Conversation Behavior during chat turns             |
| WebSocket      | existing SDK / voice routes          | Apply channel-aware behavior during streaming chat or voice turns  |
| POST / Webhook | existing channel ingress routes      | Seed and consume Conversation Behavior on normalized inbound turns |

### API (Studio)

Phase 1 should extend existing Studio authoring and localization surfaces.

| Method   | Path                               | Purpose                                                           |
| -------- | ---------------------------------- | ----------------------------------------------------------------- |
| Existing | project authoring / preview routes | Validate and persist ABL-native Conversation Behavior             |
| Existing | localization asset routes          | Manage phrase and pronunciation assets referenced by the feature  |
| Existing | project export / bundle routes     | Preserve authoring and asset references during project round-trip |

### Admin Portal

N/A for phase 1. Admin does not author tenant-specific Conversation Behavior in the initial slice.

### Channel / SDK / Voice / A2A / MCP Integration

- **Text and SDK chat** consume `interaction` and relevant `speaking` behavior while ignoring voice-only `listening` controls.
- **Voice channels** consume both conversational policy and acoustic voice rendering after capability gating.
- **Messaging channels** can honor brevity, repair, grounding, and closure while rejecting voice-only controls.
- **A2A / MCP / indirect turns** should still resolve deterministic Conversation Behavior even when a user is not interacting through a human-facing voice channel.

---

## 9. Data Model

### Collections / Tables

No new top-level collection is required in phase 1. The feature reuses:

- agent source documents
- behavior-profile source documents
- compiled agent IR
- project localization / vocabulary assets
- runtime session interaction state

### Canonical Authoring / IR Shape

```typescript
interface ConversationBehaviorAST {
  speaking?: ConversationSpeakingAST;
  listening?: ConversationListeningAST;
  interaction?: ConversationInteractionAST;
}

interface ConversationBehaviorIR {
  speaking?: {
    style?: string;
    tone?: string;
    emotion?: string;
    pace?: string;
    language_policy?: 'interaction_context' | 'agent_default' | 'fixed';
    fixed_language?: string;
    max_sentences?: number;
    one_thing_at_a_time?: boolean;
    tool_lead_in?: string;
    tool_results?: {
      style?: string;
      max_points?: number;
    };
    readback?: {
      numbers?: string;
      codes?: string;
      critical_details?: string;
    };
    phrases_ref?: string;
    pronunciations_ref?: string;
  };
  listening?: {
    barge_in?: string;
    on_pause?: string;
    on_overlap?: string;
    on_unclear_audio?: string;
    on_self_correction?: string;
  };
  interaction?: {
    answer_shape?: string;
    detail?: string;
    initiative?: string;
    grounding?: Record<string, unknown>;
    clarification?: Record<string, unknown>;
    confirmation?: Record<string, unknown>;
    uncertainty?: Record<string, unknown>;
    empathy?: string;
    context?: Record<string, unknown>;
    repair?: Record<string, unknown>;
    closure?: string;
  };
}

interface ResolvedConversationBehavior {
  source_chain: string[];
  capability_drops: string[];
  asset_refs: string[];
  speaking: Record<string, unknown>;
  listening: Record<string, unknown>;
  interaction: Record<string, unknown>;
}
```

### Key Relationships

- agent-level Conversation Behavior defines the baseline contract
- behavior-profile Conversation Behavior provides conditional overrides
- `InteractionContext` influences language policy and locale-sensitive asset resolution
- channel behavior contracts determine which runtime policies are legal on a surface
- existing `VOICE:` and execution voice config remain separate inputs used alongside the resolved behavior

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                        | Extend AST types with Conversation Behavior blocks at agent and behavior-profile scope |
| `packages/core/src/parser/agent-based-parser.ts`                | Parse `CONVERSATION:` blocks and nested field groups                                   |
| `packages/compiler/src/platform/ir/schema.ts`                   | Define `ConversationBehaviorIR` and attach it to agent/profile IR                      |
| `packages/compiler/src/platform/ir/compiler.ts`                 | Compile agent-level Conversation Behavior into canonical IR                            |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Compile behavior-profile Conversation Behavior overrides                               |
| `apps/runtime/src/services/execution/profile-resolver.ts`       | Merge base behavior and active profile overrides                                       |
| `apps/runtime/src/services/execution/interaction-context.ts`    | Remain the canonical owner of resolved language/locale/timezone                        |
| `apps/runtime/src/channels/channel-behavior-contract.ts`        | Provide capability-gating decisions by channel family                                  |

### Routes / Handlers

| File                                                                    | Purpose                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/localization/route.ts`           | Existing project asset management for phrase and pronunciation references |
| `apps/studio/src/app/api/projects/[id]/localization/[assetId]/route.ts` | Existing localized asset CRUD reused by Conversation Behavior             |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                 | Preserve authoring and asset references during export                     |
| `apps/studio/src/app/api/projects/[id]/bundle/route.ts`                 | Preserve authoring and asset references in project bundles                |

### UI Components

| File                                                          | Purpose                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/studio/src/components/profiles/ProfileDetailPage.tsx`   | Add structured Conversation Behavior editing to behavior profiles   |
| `apps/studio/src/components/agent-detail/BehaviorSection.tsx` | Display baseline Conversation Behavior on agents                    |
| `apps/studio/src/store/agent-detail-store.ts`                 | Parse compiled conversation behavior into Studio state              |
| `apps/studio/src/store/profile-store.ts`                      | Track profile-scoped conversation behavior summaries and categories |
| `apps/studio/src/lib/abl-serializers.ts`                      | Serialize `CONVERSATION:` blocks to raw ABL                         |

### Jobs / Workers / Background Processes

| File | Purpose                                                    |
| ---- | ---------------------------------------------------------- |
| N/A  | No new worker or background process is required in phase 1 |

### Tests

| File                                                                        | Type               | Coverage Focus                                                 |
| --------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `packages/core/src/__tests__/behavior-profile-parser.test.ts`               | unit / integration | Parser support for agent/profile `CONVERSATION:` blocks        |
| `packages/compiler/src/__tests__/ir/compile-behavior-profile.test.ts`       | integration        | Compiler lowering and precedence for profile overrides         |
| `apps/runtime/src/__tests__/behavior-profiles-integration.test.ts`          | integration        | Effective merge behavior and runtime capability gating         |
| `apps/runtime/src/__tests__/execution/interaction-context-resolver.test.ts` | integration        | Language-policy interaction with canonical interaction context |
| `apps/studio/src/__tests__/profile-serializer.test.ts`                      | unit / integration | Studio round-trip serialization of `CONVERSATION:`             |
| `packages/project-io/src/__tests__/profile-roundtrip.test.ts`               | integration        | Import/export round-trip for authoring plus asset refs         |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                        |
| -------- | ------- | -------------------------------------------------- |
| N/A      | N/A     | No new environment variable is required in phase 1 |

### Runtime Configuration

- channel capability decisions continue to come from `apps/runtime/src/channels/channel-behavior-contract.ts`
- language/locale/timezone continue to resolve through canonical `InteractionContext`
- phrase and pronunciation assets continue to follow project-local asset ownership and validation rules
- existing `VOICE:` config remains the source of acoustic voice rendering

### DSL / Agent IR / Schema

Representative phase-1 ABL shape:

```yaml
AGENT: Concierge
PERSONA: 'Helpful travel concierge for busy professionals'

CONVERSATION:
  SPEAKING:
    STYLE: 'warm and concise'
    TONE: 'reassuring'
    EMOTION: 'calm'
    PACE: steady
    LANGUAGE_POLICY: interaction_context
    MAX_SENTENCES: 2
    ONE_THING_AT_A_TIME: true
    TOOL_LEAD_IN: brief
    TOOL_RESULTS:
      STYLE: top_option_first
      MAX_POINTS: 2
    HANDOFFS:
      INTERNAL: silent
      HUMAN: explicit
    PHRASES_REF: 'project:conversation/common'
    PRONUNCIATIONS_REF: 'project:conversation/pronunciations'
  LISTENING:
    BARGE_IN: allow
    ON_PAUSE: wait_briefly
    ON_OVERLAP: stop_and_listen
    ON_UNCLEAR_AUDIO: ask_to_repeat_or_confirm
    ON_SELF_CORRECTION: follow_latest_intent
  INTERACTION:
    ANSWER_SHAPE: answer_first
    DETAIL: expandable
    INITIATIVE: guided
    GROUNDING:
      MODE: acknowledge_then_answer
    CLARIFICATION:
      MODE: ask_only_when_blocked
      MAX_QUESTIONS: 1
      ASSUME_WHEN_LOW_RISK: true
    CONFIRMATION:
      PARAMETERS: when_ambiguous
      ACTIONS: before_sensitive_actions
    UNCERTAINTY:
      MODE: say_when_unsure
      OFFER_NEXT_STEP: true
    EMPATHY: acknowledge_when_emotional
    CONTEXT:
      AVOID_REASKING: true
      REMEMBER_RECENT_CONSTRAINTS: true
    REPAIR:
      ON_CORRECTION: accept_and_update
      ON_CONFUSION: rephrase_briefly
      ON_MISHEARD: confirm_best_guess
      MAX_ATTEMPTS: 2
    CLOSURE: summarize_outcome
```

Behavior-profile override shape:

```yaml
BEHAVIOR_PROFILE: voice_core
PRIORITY: 20
WHEN: channel.behavior_profile == "voice_core"

CONVERSATION:
  SPEAKING:
    MAX_SENTENCES: 2
    TOOL_LEAD_IN: brief
  LISTENING:
    BARGE_IN: allow
    ON_OVERLAP: stop_and_listen
  INTERACTION:
    CONFIRMATION:
      ACTIONS: before_sensitive_actions
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project-owned phrase and pronunciation assets must resolve only within the owning project and return 404 on cross-project access. |
| Tenant isolation  | Any control-plane read/write for referenced assets must include `tenantId` and fail closed across tenants.                        |
| User isolation    | User-specific preview or in-progress authoring state must not leak another user's changes or asset references.                    |

### Security & Compliance

- Compile-time and preview-time validation must fail closed for unsupported channel semantics and asset references.
- User-visible diagnostics must stay sanitized and should not leak provider internals, raw runtime remediation advice, or hidden platform asset identifiers.
- Conversation Behavior must not create a side channel that overrides platform-owned channel or voice security controls.
- Confirmation and uncertainty behavior must remain compatible with safety/compliance rules that may have stricter precedence.

### Performance & Scalability

- Resolved Conversation Behavior must be computed in-memory from compiled IR, active profiles, and interaction context.
- Asset lookups must reuse existing project localization loading patterns rather than add a new runtime network hop.
- Prompt inflation must stay bounded; large phrase banks belong in referenced assets and sampled examples, not inlined prompt blobs.
- Capability gating must be a cheap channel-family lookup, not an unbounded runtime rules engine.

### Reliability & Failure Modes

- Invalid authoring should fail at preview or compile time whenever possible.
- Unsupported channel-specific behavior should surface as a compile error or explicit runtime capability drop, not silent omission.
- Missing optional future inputs, such as project-level brand defaults, must degrade safely to agent/profile-local behavior.
- Runtime should preserve the last valid resolved behavior even if an optional asset lookup or future extension is unavailable.

### Observability

- Runtime should emit a resolved behavior trace or equivalent debug artifact with source chain, active profile names, asset refs, and capability drops.
- Existing profile-resolution traces should link to or compose with the resolved Conversation Behavior view.
- Preview diagnostics should explain ownership conflicts in product terms, not implementation jargon.

### Data Lifecycle

- No new durable collection is required in phase 1.
- Conversation Behavior authoring follows the lifecycle of agent/profile source and project asset versioning.
- Asset rename or deletion flows must fail closed when references would be broken.

---

## 13. Delivery Plan / Work Breakdown

1. Define the canonical model and ownership rules.
   1.1 Finalize the stable naming contract for `speaking`, `listening`, and `interaction`.
   1.2 Finalize the launch field set and mark deferred fields explicitly.
   1.3 Define the ownership matrix across persona, voice config, localization, interaction context, and channel behavior.
2. Add parser and compiler support.
   2.1 Extend AST types and parsing for `CONVERSATION:` on agents and behavior profiles.
   2.2 Introduce `ConversationBehaviorIR` and lower authoring fields into canonical IR.
   2.3 Add validation for ownership conflicts, asset references, and unsupported channel-family usage.
3. Add runtime resolution.
   3.1 Resolve one effective Conversation Behavior view per turn from base agent and active profiles.
   3.2 Merge Conversation Behavior with canonical interaction context and runtime safety rules.
   3.3 Capability-gate voice-only behavior by channel family.
4. Integrate localization and assets.
   4.1 Define reference formats for phrase and pronunciation assets.
   4.2 Reuse project-asset validation and loading paths.
   4.3 Add diagnostics for unresolved or cross-owned assets.
5. Extend Studio and project I/O.
   5.1 Add structured agent/profile editing for the feature.
   5.2 Preserve raw ABL round-trip through serializers.
   5.3 Preserve authoring and assets through export/import/bundle flows.
6. Add observability and hardening.
   6.1 Emit resolved-behavior diagnostics and traces.
   6.2 Add integration and E2E coverage for voice, chat, and localization scenarios.
   6.3 Revisit advanced and deferred fields once runtime support is proven.

---

## 14. Success Metrics

| Metric                                                            | Baseline             | Target                                                               | How Measured                                   |
| ----------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Conversational behavior concerns with an explicit canonical owner | Partial and implicit | 100% of launch fields                                                | ownership matrix and validator coverage        |
| New voice/chat authoring flows using one `CONVERSATION:` model    | 0                    | 100% of new conversation-design examples                             | Studio fixtures and docs inventory             |
| Inline duplicated locale-specific phrase content in new fixtures  | High                 | 0                                                                    | fixture and round-trip audit                   |
| Channel-family capability decisions covered by tests              | Ad hoc               | 100% of launch voice/listening policies                              | integration tests against channel contracts    |
| Runtime trace visibility for resolved behavior                    | None                 | one deterministic resolved-behavior artifact per feature-active turn | runtime trace tests and debugging walkthroughs |

---

## 15. Open Questions

1. Should pronunciation references reuse localization assets directly in phase 1 or introduce a separate vocabulary / lexicon asset type?
2. Should project-level brand voice defaults participate in phase 1 precedence, or should they remain a future extension point?
3. Which deferred fields, especially `backchannels`, `use_audio_cues`, and `adaptation`, are worth promoting into the first post-launch slice?
4. Should step-level `CONVERSATION:` overrides be allowed in a later phase, or should behavior-profile scope remain the only override mechanism?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                 | Severity | Status |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | The current platform has the right seams for persona, voice config, interaction context, localization assets, and behavior profiles, but no explicit authoring model that joins them into one conversation-design contract. | High     | Open   |
| GAP-002 | `compile-behavior-profile.ts` currently forwards only `ssml`, `instructions`, and `plain_text` for profile voice config, so voice/profile ownership is not yet fully aligned.                                               | Medium   | Open   |
| GAP-003 | Channel behavior contracts exist, but not every launch-field conversation policy is yet represented as a concrete runtime capability decision.                                                                              | Medium   | Open   |
| GAP-004 | Phrase and pronunciation asset references are not yet first-class authoring constructs in Studio.                                                                                                                           | Medium   | Open   |
| GAP-005 | There is no project-level brand voice contract yet, so branded style inheritance remains a future extension.                                                                                                                | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                    | Coverage Type        | Status     | Test File / Note                   |
| --- | ------------------------------------------------------------------------------------------- | -------------------- | ---------- | ---------------------------------- |
| 1   | Agent-level `CONVERSATION:` parsing and serialization                                       | unit / integration   | NOT TESTED | parser + serializer suites         |
| 2   | Behavior-profile-scoped overrides compile into canonical IR                                 | integration          | NOT TESTED | compiler + profile resolver suites |
| 3   | Ownership conflicts fail closed at preview/compile time                                     | unit / integration   | NOT TESTED | validator diagnostics              |
| 4   | `language_policy` resolves through canonical interaction context                            | integration          | NOT TESTED | runtime interaction-context tests  |
| 5   | Channel-family capability gating rejects unsupported voice-only behavior                    | integration          | NOT TESTED | runtime channel tests              |
| 6   | Phrase and pronunciation asset references resolve per locale and survive project round-trip | integration / e2e    | NOT TESTED | localization + project I/O tests   |
| 7   | Studio authoring round-trips the feature through structured UI and raw ABL                  | integration / manual | NOT TESTED | Studio section + serializer tests  |
| 8   | Resolved Conversation Behavior trace exposes active sources and capability drops            | integration          | NOT TESTED | runtime trace/debug tests          |

### Testing Notes

The platform already has meaningful baseline coverage in behavior-profile parsing, profile resolution, interaction-context resolution, Studio serialization, and project asset handling. This feature should extend those seams rather than create a parallel testing stack.

> Full testing details: [docs/testing/sub-features/conversation-behavior.md](../../testing/sub-features/conversation-behavior.md)

---

## 18. References

- Design docs: `docs/specs/conversation-behavior.hld.md`, `docs/plans/2026-04-21-conversation-behavior-impl-plan.md`
- Related feature docs: [ABL Language](../abl-language.md), [Voice Capabilities](../voice-capabilities.md), [Channels](../channels.md), [Localized Interaction Context](localized-interaction-context.md), [Localization Asset Management](localization-asset-management.md)
