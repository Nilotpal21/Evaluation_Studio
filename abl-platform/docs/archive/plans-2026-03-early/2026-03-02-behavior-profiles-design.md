# Behavior Profiles — Design Document

**Date**: 2026-03-02
**Status**: Approved
**Driver**: Customer-driven — multiple customers deploying same agents across 3+ channels need distinct behavior per channel, region, caller context, and environment.

## Problem Statement

Customers deploying agents across multiple channels (WhatsApp, voice, web chat, Slack, Teams, email) face three anti-patterns:

1. **Duplicate agents per channel** — `booking_agent_whatsapp`, `booking_agent_voice` with copy-pasted logic and channel-specific tweaks. Maintenance nightmare.
2. **Runtime hacks in tools** — Tool code detects channel and branches behavior, bypassing the DSL entirely.
3. **Manual prompt engineering** — Single GOAL/INSTRUCTIONS block crammed with "if on WhatsApp do X, if on voice do Y." Fragile and unscalable.

The platform has a well-architected channel adapter layer (10 adapters, rich content transforms, voice config), but **no first-class DSL mechanism** for agents to declare behavioral differences based on channel, caller, or environment context.

## Requirements

- **One agent, multiple behaviors**: A single agent definition should support distinct behavior across channels, regions, caller tiers, and other context dimensions.
- **Composable and reusable**: Define a "WhatsApp Brazil" profile once, reuse across many agents. Eliminate duplication.
- **Layered identity**: Base agent identity + additive/override layers from profiles. Not wholesale replacement.
- **Full behavioral scope**: Profiles can modify instructions, constraints, tool visibility, gather field behavior, response formatting, voice config, and flow structure.
- **Multi-attribute matching**: Profiles activate based on CEL predicates over channel, caller, session, and environment attributes — not just channel name.
- **Explicit priority**: When multiple profiles match, explicit numeric priority resolves conflicts. No implicit specificity rules.
- **Compile-time validation**: Profile references, flow step targets, tool references validated during compilation.
- **Developer experience**: Studio UI for creating, editing, previewing profiles. Arch AI assistant generates profiles from natural language. Import/export includes profiles.

## Design

### 1. DSL Syntax — `BEHAVIOR_PROFILE`

A `BEHAVIOR_PROFILE` is a standalone `.behavior_profile.abl` file — a reusable, composable unit that defines how agent behavior changes when context matches a CEL predicate.

#### File structure

```abl
# profiles/latam_whatsapp.behavior_profile.abl

BEHAVIOR_PROFILE: latam_whatsapp
  PRIORITY: 20
  WHEN: >
    channel.name == "whatsapp"
    && channel.region in ["BR", "MX", "CO", "AR", "CL"]
    && channel.number_type == "business"

  # Layered identity overrides (appended to base)
  INSTRUCTIONS: |
    Respond in Spanish or Portuguese based on channel.region.
    Keep responses under 160 characters.
    Use formal address ("usted" / "senhor").
    Never use markdown formatting.

  # Constraints (additive to agent's base constraints)
  CONSTRAINTS:
    - "Response must not exceed 1024 characters"
    - "No URLs in responses unless explicitly requested"

  # Response formatting rules (override base per-field)
  RESPONSE:
    MAX_BUTTONS: 3
    FALLBACK_FORMAT: plain_text
    MEDIA: [image, document, audio]
    MAX_RESPONSE_LENGTH: 1024

  # Voice config (merged with base)
  VOICE:
    PLAIN_TEXT: true

  # Tool visibility (modify base set)
  TOOLS:
    HIDE: [send_email, generate_pdf]
    # ADD: [whatsapp_template_sender]

  # Gather field overrides (deep merge per field)
  GATHER:
    VALIDATION_STYLE: strict
    CONFIRMATION: always
    FIELD_OVERRIDES:
      phone_number:
        EXTRACTION_HINTS:
          - "Accept +55 prefix for Brazil"
          - "Accept +52 for Mexico"
        PROMPT: "Please send your phone number with country code"

  # Flow modifications
  FLOW:
    SKIP: [loyalty_lookup, pdf_generation]
    ADD_BEFORE gather_payment:
      whatsapp_payment_info:
        RESPOND: "WhatsApp payments require confirmation. I'll send a payment link."
    OVERRIDE:
      welcome:
        RESPOND: "Olá! Como posso ajudar?"
```

```abl
# profiles/voice_friendly.behavior_profile.abl

BEHAVIOR_PROFILE: voice_friendly
  PRIORITY: 10
  WHEN: channel.name.startsWith("voice")

  INSTRUCTIONS: |
    Speak naturally with short sentences.
    Avoid lists longer than 3 items.
    Confirm important details by repeating them back.

  VOICE:
    INSTRUCTIONS: "Warm, professional tone. Medium pace."

  CONSTRAINTS:
    - "Response sentences must be under 20 words each"
    - "Never respond with more than 3 sentences at once"

  TOOLS:
    HIDE: [show_carousel, display_map]

  GATHER:
    CONFIRMATION: always
    FIELD_OVERRIDES:
      email:
        PROMPT: "Can you spell out your email address for me?"
        EXTRACTION_HINTS: ["User will spell out letter by letter"]

  # Entirely separate flow for voice
  FLOW:
    REPLACE: voice_booking_flow
```

#### Agent references

```abl
AGENT: booking_agent
  GOAL: "Help users book hotels"

  USE BEHAVIOR_PROFILE: latam_whatsapp
  USE BEHAVIOR_PROFILE: voice_friendly
  USE BEHAVIOR_PROFILE: web_rich
  USE BEHAVIOR_PROFILE: slack_workspace

  INSTRUCTIONS: |
    You are a professional hotel booking assistant.

  FLOW:
    welcome:
      RESPOND: "Welcome! How can I help you book a hotel?"
    ...
```

### 2. Context Object for CEL Matching

The `WHEN` clause evaluates against a unified context object assembled at runtime from existing session, connection, and environment data:

| Field                        | Source                                 |
| ---------------------------- | -------------------------------------- |
| `channel.name`               | `ResolvedConnection.channelType`       |
| `channel.region`             | `ResolvedConnection.config.region`     |
| `channel.number_type`        | `ResolvedConnection.config.numberType` |
| `channel.provider`           | `ResolvedConnection.config.provider`   |
| `channel.tags`               | `ResolvedConnection.config.tags`       |
| `channel.capabilities`       | `ChannelCapabilities` from adapter     |
| `caller.identity_tier`       | `CallerContext.identityTier` (0/1/2)   |
| `caller.customer_id`         | `CallerContext.customerId`             |
| `caller.is_authenticated`    | Derived: `identityTier > 0`            |
| `caller.verification_method` | `CallerContext.verificationMethod`     |
| `caller.tags`                | `CallerContext` metadata               |
| `session.is_new`             | Derived: no prior messages             |
| `session.language`           | Detected or configured locale          |
| `session.turn_count`         | `conversationHistory.length / 2`       |
| `env.deployment_region`      | Platform config                        |
| `env.timestamp`              | `Date.now()`                           |

#### Connection schema extension

`ResolvedConnection.config` gains standardized optional fields:

```typescript
interface ChannelConnectionConfig {
  region?: string; // "BR", "US", "EU"
  number_type?: string; // "toll_free", "local", "shortcode", "business"
  provider?: string; // "twilio", "meta_cloud", "jambonz"
  tags?: Record<string, string>; // Arbitrary key-value pairs
  // ... existing config fields
}
```

Configured when customers set up channel connections in Studio.

### 3. IR Schema — `BehaviorProfileIR`

New types added to `packages/compiler/src/platform/ir/schema.ts`:

```typescript
// Added to AgentIR
export interface AgentIR {
  // ... existing fields ...
  behavior_profiles?: BehaviorProfileIR[];
}

export interface BehaviorProfileIR {
  name: string;
  priority: number;
  when: string; // Compiled CEL expression

  instructions?: string;
  voice?: VoiceConfigIR;
  response_rules?: ResponseRulesIR;
  constraints?: ConstraintIR[];

  tools_hide?: string[];
  tools_add?: ToolDefinition[];

  gather_overrides?: GatherProfileOverrides;

  flow_modifications?: FlowModificationsIR;
  flow_replace?: string;
}

export interface ResponseRulesIR {
  max_buttons?: number;
  fallback_format?: 'plain_text' | 'markdown' | 'html';
  media_types?: string[];
  max_response_length?: number;
}

export interface GatherProfileOverrides {
  validation_style?: 'strict' | 'lenient';
  confirmation?: 'always' | 'never' | 'on_change';
  field_overrides?: Record<string, GatherFieldProfileOverride>;
}

export interface GatherFieldProfileOverride {
  prompt?: string;
  extraction_hints?: string[];
  skip?: boolean;
  required?: boolean;
  validation?: string;
}

export interface FlowModificationsIR {
  skip?: string[];
  overrides?: Record<string, FlowStepOverrideIR>;
  insertions?: FlowInsertionIR[];
}

export interface FlowStepOverrideIR {
  respond?: string;
  voice?: VoiceConfigIR;
  rich_content?: RichContentIR;
  transition?: string;
  actions?: ActionSetIR;
}

export interface FlowInsertionIR {
  position: 'before' | 'after';
  target_step: string;
  step: FlowStepIR;
}
```

### 4. Compilation Pipeline

#### New file type

Parser recognizes `BEHAVIOR_PROFILE:` as a top-level keyword (alongside `AGENT:` and `SUPERVISOR:`).

#### Compilation steps

1. **Parse** `.behavior_profile.abl` files → `BehaviorProfileAST`
2. **For each agent with `USE BEHAVIOR_PROFILE:`**:
   - Resolve profile reference (must exist in same project)
   - Validate WHEN expression (CEL syntax check)
   - Validate FLOW references (SKIP/OVERRIDE/ADD_BEFORE targets exist in agent's base flow)
   - Validate TOOLS.HIDE references declared tools
   - Validate no duplicate PRIORITY values across profiles on same agent
3. **Compile** profile sections → `BehaviorProfileIR` (reusing existing section compilers for constraints, voice, tools, flow steps)
4. **Attach** compiled profiles to `AgentIR.behavior_profiles[]` sorted by priority

#### Compile-time diagnostics

| Code                        | Severity | Description                                     |
| --------------------------- | -------- | ----------------------------------------------- |
| `PROFILE_PRIORITY_CONFLICT` | Error    | Two profiles on same agent have same priority   |
| `PROFILE_UNKNOWN_STEP`      | Error    | SKIP/OVERRIDE references non-existent flow step |
| `PROFILE_UNKNOWN_TOOL`      | Error    | TOOLS.HIDE references non-existent tool         |
| `PROFILE_INVALID_WHEN`      | Error    | CEL expression doesn't parse                    |
| `PROFILE_FLOW_CONFLICT`     | Error    | FLOW.REPLACE + flow_modifications both set      |
| `PROFILE_CIRCULAR_INSERT`   | Error    | ADD_BEFORE X where X is also SKIPped            |
| `PROFILE_UNUSED`            | Warning  | Profile defined but not referenced by any agent |

### 5. Runtime Resolution

#### Profile context assembly

When a message arrives, the runtime assembles the context object from existing data:

```typescript
// apps/runtime/src/services/execution/profile-resolver.ts

export interface ProfileContext {
  channel: {
    name: string;
    region: string;
    number_type: string;
    provider: string;
    tags: Record<string, string>;
    capabilities: {
      streaming: boolean;
      media: boolean;
      threading: boolean;
      interactive: boolean;
    };
  };
  caller: {
    identity_tier: number;
    customer_id: string | null;
    is_authenticated: boolean;
    verification_method: string;
    tags: Record<string, string>;
  };
  session: {
    is_new: boolean;
    language: string;
    turn_count: number;
  };
  env: {
    deployment_region: string;
    timestamp: number;
  };
}
```

#### Resolution algorithm

```typescript
export function resolveActiveProfiles(
  agentIR: AgentIR,
  context: ProfileContext,
): BehaviorProfileIR[] {
  if (!agentIR.behavior_profiles?.length) return [];

  const matched: BehaviorProfileIR[] = [];
  for (const profile of agentIR.behavior_profiles) {
    if (evaluateCelCondition(profile.when, context)) {
      matched.push(profile);
    }
  }

  // Sort ascending: applied low→high, so highest priority applied last = wins
  return matched.sort((a, b) => a.priority - b.priority);
}
```

#### Effective config builder

Applies matched profiles onto the base AgentIR to produce the agent's effective configuration for this session:

```typescript
export function buildEffectiveConfig(
  baseIR: AgentIR,
  activeProfiles: BehaviorProfileIR[],
): EffectiveAgentConfig {
  const effective = initFromBase(baseIR);

  for (const profile of activeProfiles) {
    // INSTRUCTIONS: append (additive)
    if (profile.instructions) effective.additionalInstructions.push(profile.instructions);

    // CONSTRAINTS: additive
    if (profile.constraints) effective.constraints.push(...profile.constraints);

    // TOOLS: hide then add
    if (profile.tools_hide)
      effective.tools = effective.tools.filter((t) => !profile.tools_hide!.includes(t.name));
    if (profile.tools_add) effective.tools.push(...profile.tools_add);

    // VOICE: merge (profile fields overwrite base)
    if (profile.voice) effective.voice = { ...effective.voice, ...profile.voice };

    // RESPONSE_RULES: override per-field
    if (profile.response_rules)
      effective.responseRules = {
        ...effective.responseRules,
        ...profile.response_rules,
      };

    // GATHER: deep merge field overrides
    if (profile.gather_overrides) applyGatherOverrides(effective.gather, profile.gather_overrides);

    // FLOW: replace or modify
    if (profile.flow_replace) effective.flow = resolveNamedFlow(profile.flow_replace, baseIR);
    else if (profile.flow_modifications)
      applyFlowModifications(effective.flow, profile.flow_modifications);
  }

  return effective;
}
```

#### Override merge semantics

| Section                  | Merge Behavior                            | Multi-profile stacking                                         |
| ------------------------ | ----------------------------------------- | -------------------------------------------------------------- |
| `INSTRUCTIONS`           | **Append** to base                        | All matching profiles' instructions appended in priority order |
| `CONSTRAINTS`            | **Additive**                              | All matching profiles' constraints added                       |
| `TOOLS.HIDE`             | **Subtractive** from base                 | Cumulative — each profile can hide more tools                  |
| `TOOLS.ADD`              | **Additive** to base                      | Cumulative — each profile can add tools                        |
| `RESPONSE`               | **Override per-field**                    | Higher priority wins per-field                                 |
| `VOICE`                  | **Merge** (profile fields overwrite base) | Higher priority wins per-field                                 |
| `GATHER.FIELD_OVERRIDES` | **Deep merge** per field                  | Higher priority wins per-field                                 |
| `FLOW.SKIP`              | **Remove** steps                          | Cumulative                                                     |
| `FLOW.ADD_BEFORE/AFTER`  | **Insert** steps                          | All insertions applied                                         |
| `FLOW.OVERRIDE`          | **Replace** step properties               | Higher priority wins per-step                                  |
| `FLOW.REPLACE`           | **Complete replacement**                  | Highest priority REPLACE wins                                  |

#### Resolution timing

- **New session**: Resolve profiles, cache `EffectiveAgentConfig` on session
- **Same channel/caller**: Use cached effective config
- **Channel transfer**: Re-resolve profiles, rebuild effective config
- **Session resume on different pod**: Rehydrate from stored active profile names, rebuild effective config

#### Trace events

```typescript
{
  type: 'profile_resolution',
  data: {
    evaluated: ['latam_whatsapp', 'voice_friendly', 'anon_guard'],
    matched: ['latam_whatsapp', 'anon_guard'],
    context_snapshot: { channel: { name: 'whatsapp', region: 'BR' }, ... },
    effective_overrides: {
      instructions_appended: 2,
      tools_hidden: ['send_email'],
      tools_added: [],
      constraints_added: 2,
      flow_steps_skipped: ['loyalty_lookup'],
      flow_steps_overridden: ['welcome'],
      gather_fields_modified: ['phone_number'],
    }
  }
}
```

### 6. Runtime Integration Points

| Component              | Change                          | How                                                             |
| ---------------------- | ------------------------------- | --------------------------------------------------------------- |
| **Prompt Builder**     | Inject `additionalInstructions` | Append after base identity section                              |
| **Tool Resolution**    | Use `effective.tools`           | Filter/extend tool list before building LLM definitions         |
| **Constraint Checker** | Use `effective.constraints`     | Merge profile constraints into evaluation set                   |
| **Flow Executor**      | Use `effective.flow`            | Step lookup uses modified flow                                  |
| **Gather Executor**    | Use `effective.gather`          | Field prompts, validation, required status from overrides       |
| **Voice Runtime**      | Use `effective.voice`           | TTS config from merged voice settings                           |
| **Response Transform** | Use `effective.responseRules`   | Button limits, fallback format applied before adapter transform |
| **Inbound Worker**     | Assemble `ProfileContext`       | Build context from connection + caller + session data           |
| **Session Store**      | Cache effective config          | Store `_activeProfileNames` and `_effectiveConfig` on session   |

### 7. Studio UX

#### Navigation

Behavior Profiles get their own sidebar nav item at project level (between Agents and Tools), since profiles are shared across agents.

#### Profile List Page

Grid of cards showing: name, priority badge, truncated WHEN expression, "Used by: N agents" count, active override categories (chips), last updated timestamp.

#### Profile Detail/Editor Page

Section-centric accordion layout consistent with AgentDetailPage:

| Section          | Contents                                                             |
| ---------------- | -------------------------------------------------------------------- |
| **MATCH**        | WHEN expression (CEL editor), PRIORITY number                        |
| **INSTRUCTIONS** | Textarea for additional instructions                                 |
| **CONSTRAINTS**  | Constraint list editor (reuse agent constraints component)           |
| **RESPONSE**     | Form: max_buttons, fallback_format, media types, max_response_length |
| **VOICE**        | Voice config form (reuse agent voice component)                      |
| **TOOLS**        | "Hide" list + "Add" tool definitions                                 |
| **GATHER**       | Field override table                                                 |
| **FLOW**         | Flow modification editor: skip, overrides, insertions, or REPLACE    |

Raw DSL toggle available via "View Raw DSL" overlay.

#### Agent Detail Page — BEHAVIOR section

New accordion section on agent detail page showing attached profiles as cards. Each card shows profile name, priority, WHEN clause, override summary, and View/Remove actions.

**Channel preview**: Dropdown to simulate a channel context and view the effective merged config (read-only).

#### Agent Card badges

Agent list cards show `[N profiles]` badge with hover tooltip listing profile names.

### 8. Import / Export (project-io)

#### Export folder structure

```
<project-slug>/
  project.json
  abl.lock
  agents/
    supervisor.agent.abl
    booking_manager.agent.abl
  profiles/
    latam_whatsapp.behavior_profile.abl
    voice_friendly.behavior_profile.abl
  tools/
    hotels_api.tools.abl
  config/
    models.json
  deployments/
    dev.deployment.json
```

#### Manifest extension

```typescript
interface ManifestProfile {
  name: string;
  path: string;
  priority: number;
  when_summary: string;
  used_by: string[];
}

interface ProjectManifest {
  // ... existing ...
  profiles?: ManifestProfile[];
}
```

#### Dependency tracking

`USE BEHAVIOR_PROFILE: xyz` is a dependency edge from agent → profile. Import validation warns if a referenced profile is missing. Unused profiles are included in export (reusable assets).

#### Folder reader/builder

- Reader: `.behavior_profile.abl` files categorized into `result.profiles`
- Builder: profiles written to `profiles/{name}.behavior_profile.abl`
- Diff: added/modified/removed profiles shown in import preview

### 9. Arch AI Assistant

#### Context builder

`arch-context-builder.ts` extended to include behavior profiles in `ArchAgentContext`:

```typescript
behavior_profiles?: {
  name: string;
  priority: number;
  when: string;
  overrides: string[];
}[];
```

`formatContextForLLM()` adds a "Behavior Profiles" section listing attached profiles with their WHEN clauses and override summaries.

#### Capabilities

| User says                                | Arch action                                                 |
| ---------------------------------------- | ----------------------------------------------------------- |
| "Make this agent work on WhatsApp"       | Create profile + add `USE` reference                        |
| "On voice, skip the PDF step"            | Add FLOW.SKIP to voice profile                              |
| "WhatsApp responses are too long"        | Add RESPONSE.MAX_RESPONSE_LENGTH to WhatsApp profile        |
| "Show me what this looks like on Slack"  | Resolve profiles for simulated Slack context, show config   |
| "Create a profile for premium customers" | Generate profile with `WHEN: caller.tags.tier == "premium"` |

#### Quick actions

- Profile list page: "Suggest profiles for this project", "Find redundant profiles", "Audit profile coverage"
- Agent detail BEHAVIOR section: "Add WhatsApp support", "Preview on [channel]", "Simplify profiles"

### 10. Testing Strategy

#### Compile-time tests

- Profile parsing (valid/invalid syntax, all sections)
- CEL WHEN expression validation
- Cross-reference validation (step names, tool names, priority conflicts)
- Profile attachment to AgentIR

#### Runtime tests

- Context assembly from session/connection/caller data
- Profile resolution (single match, multiple match, no match, priority ordering)
- Effective config building (each merge semantic: append, additive, subtractive, override, deep merge, replace)
- Flow modifications (skip, insert, override, replace)
- Re-resolution on channel transfer

#### Integration tests

- End-to-end: agent with profiles on WhatsApp vs. voice vs. web → different behaviors
- Prompt builder with active profiles → correct system prompt
- Tool resolution with hidden/added tools
- Constraint evaluation with profile constraints
- Session rehydration across pods with active profiles

#### Studio tests

- Profile CRUD in UI
- Agent profile attachment/removal
- Channel preview rendering
- Import/export round-trip with profiles

### 11. Migration & Backward Compatibility

- `behavior_profiles` is an optional field on `AgentIR` — existing agents without profiles are unaffected
- No changes to existing DSL parsing for agents without `USE BEHAVIOR_PROFILE:`
- Existing `VOICE:` and `FORMATS:` sections on agents continue to work as base behavior
- `ResolvedConnection.config` new fields (region, number_type, provider, tags) are all optional — existing connections don't need updates
- IR version stays at `1.0` — the field is additive

### 12. Future Extensions

- **Profile inheritance**: A profile extending another profile (`EXTENDS: base_whatsapp`)
- **Profile conditions on session.values**: Match on gathered field values (e.g., "if customer selected 'premium' plan")
- **Profile A/B testing**: Randomly assign profiles for experimentation
- **Profile analytics**: Track which profiles activate most, performance per profile
- **Inline WHEN CHANNEL blocks**: Lightweight per-step overrides without full profile files (if customer demand warrants it)

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add composable `BEHAVIOR_PROFILE` DSL construct enabling agents to behave differently based on channel, caller, session, and environment context — eliminating per-channel agent duplication.

**Architecture:** New `.behavior_profile.abl` file type parsed and compiled alongside agents. Profiles carry CEL-based WHEN predicates evaluated at runtime against a unified context object. Matching profiles are applied as overlays on the base AgentIR to produce an effective agent config cached per session. Studio gets a new entity type for profile CRUD, and project-io supports import/export.

**Tech Stack:** TypeScript, CEL evaluator (existing), Vitest, ABL parser (existing), IR compiler (existing), Zustand (Studio stores), React (Studio components)

**Design Doc:** `docs/plans/2026-03-02-behavior-profiles-design.md`

---

## Phase 1: IR Types & Schema

### Task 1.1: Add BehaviorProfileIR Types to IR Schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:108-177` (AgentIR interface)
- Test: `packages/compiler/src/__tests__/ir/behavior-profile-ir.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/ir/behavior-profile-ir.test.ts
import { describe, it, expect } from 'vitest';
import type {
  AgentIR,
  BehaviorProfileIR,
  ResponseRulesIR,
  GatherProfileOverrides,
  GatherFieldProfileOverride,
  FlowModificationsIR,
  FlowStepOverrideIR,
  FlowInsertionIR,
} from '../../platform/ir/schema.js';

describe('BehaviorProfileIR types', () => {
  it('should allow behavior_profiles on AgentIR', () => {
    const profile: BehaviorProfileIR = {
      name: 'whatsapp_standard',
      priority: 20,
      when: 'channel.name == "whatsapp"',
      instructions: 'Keep responses short.',
      constraints: [],
      tools_hide: ['send_email'],
      response_rules: { max_buttons: 3, fallback_format: 'plain_text' },
    };

    const ir: Partial<AgentIR> = {
      ir_version: '1.0',
      behavior_profiles: [profile],
    };

    expect(ir.behavior_profiles).toHaveLength(1);
    expect(ir.behavior_profiles![0].name).toBe('whatsapp_standard');
    expect(ir.behavior_profiles![0].priority).toBe(20);
  });

  it('should support all override sections', () => {
    const profile: BehaviorProfileIR = {
      name: 'voice_friendly',
      priority: 10,
      when: 'channel.name.startsWith("voice")',
      instructions: 'Speak naturally.',
      voice: { instructions: 'Warm tone', plain_text: 'Welcome' },
      response_rules: {
        max_buttons: 0,
        fallback_format: 'plain_text',
        media_types: ['audio'],
        max_response_length: 500,
      },
      constraints: [
        {
          condition: 'len(response) < 500',
          on_fail: { type: 'respond', message: 'Too long' },
        },
      ],
      tools_hide: ['show_carousel'],
      tools_add: [
        {
          name: 'voice_transfer',
          description: 'Transfer call',
          parameters: [],
          returns: { type: 'object' },
          hints: {},
        },
      ],
      gather_overrides: {
        validation_style: 'strict',
        confirmation: 'always',
        field_overrides: {
          email: {
            prompt: 'Spell your email',
            extraction_hints: ['Letter by letter'],
            skip: false,
            required: true,
          },
        },
      },
      flow_modifications: {
        skip: ['pdf_generation'],
        overrides: {
          welcome: { respond: 'Hello via voice!' },
        },
        insertions: [
          {
            position: 'before',
            target_step: 'gather_payment',
            step: {
              name: 'voice_confirm',
              respond: 'Let me confirm your details.',
            } as any,
          },
        ],
      },
    };

    expect(profile.gather_overrides?.confirmation).toBe('always');
    expect(profile.flow_modifications?.skip).toContain('pdf_generation');
  });

  it('should support flow_replace as alternative to flow_modifications', () => {
    const profile: BehaviorProfileIR = {
      name: 'voice_flow',
      priority: 15,
      when: 'channel.name == "voice"',
      flow_replace: 'voice_booking_flow',
    };

    expect(profile.flow_replace).toBe('voice_booking_flow');
    expect(profile.flow_modifications).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir/behavior-profile-ir.test.ts`
Expected: FAIL — types `BehaviorProfileIR`, `ResponseRulesIR`, etc. don't exist

**Step 3: Add types to IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add after the `AgentIR` interface (after line ~177):

```typescript
// ─── Behavior Profile IR ───

export interface BehaviorProfileIR {
  name: string;
  priority: number;
  when: string;

  instructions?: string;
  voice?: VoiceConfigIR;
  response_rules?: ResponseRulesIR;
  constraints?: Constraint[];

  tools_hide?: string[];
  tools_add?: ToolDefinition[];

  gather_overrides?: GatherProfileOverrides;

  flow_modifications?: FlowModificationsIR;
  flow_replace?: string;
}

export interface ResponseRulesIR {
  max_buttons?: number;
  fallback_format?: 'plain_text' | 'markdown' | 'html';
  media_types?: string[];
  max_response_length?: number;
}

export interface GatherProfileOverrides {
  validation_style?: 'strict' | 'lenient';
  confirmation?: 'always' | 'never' | 'on_change';
  field_overrides?: Record<string, GatherFieldProfileOverride>;
}

export interface GatherFieldProfileOverride {
  prompt?: string;
  extraction_hints?: string[];
  skip?: boolean;
  required?: boolean;
  validation?: string;
}

export interface FlowModificationsIR {
  skip?: string[];
  overrides?: Record<string, FlowStepOverrideIR>;
  insertions?: FlowInsertionIR[];
}

export interface FlowStepOverrideIR {
  respond?: string;
  voice?: VoiceConfigIR;
  rich_content?: RichContentIR;
  transition?: string;
  actions?: ActionSetIR;
}

export interface FlowInsertionIR {
  position: 'before' | 'after';
  target_step: string;
  step: FlowStep;
}
```

And add to the `AgentIR` interface:

```typescript
export interface AgentIR {
  // ... existing fields ...
  behavior_profiles?: BehaviorProfileIR[];
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir/behavior-profile-ir.test.ts`
Expected: PASS

**Step 5: Export new types**

Ensure new types are exported from `packages/compiler/src/platform/ir/schema.ts` (they already will be since they use `export interface`). Verify they're accessible from the package barrel export.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/ir/behavior-profile-ir.test.ts
git commit -m "[ABLP-2] feat(compiler): add BehaviorProfileIR types to IR schema"
```

---

## Phase 2: Parser — BEHAVIOR_PROFILE Parsing

### Task 2.1: Parse BEHAVIOR_PROFILE Document Type

**Files:**

- Modify: `packages/core/src/types/agent-based.ts` (add BehaviorProfile AST types)
- Modify: `packages/core/src/parser/agent-based-parser.ts` (parse BEHAVIOR_PROFILE keyword)
- Test: `packages/core/src/__tests__/parser/behavior-profile-parser.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/parser/behavior-profile-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

describe('BEHAVIOR_PROFILE parsing', () => {
  it('should parse a minimal behavior profile', () => {
    const dsl = `
BEHAVIOR_PROFILE: whatsapp_standard
  PRIORITY: 20
  WHEN: channel.name == "whatsapp"

  INSTRUCTIONS: |
    Keep responses under 160 characters.
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.type).toBe('behavior_profile');
    expect(doc.name).toBe('whatsapp_standard');
    expect(doc.behaviorProfile).toBeDefined();
    expect(doc.behaviorProfile!.priority).toBe(20);
    expect(doc.behaviorProfile!.when).toBe('channel.name == "whatsapp"');
    expect(doc.behaviorProfile!.instructions).toContain('Keep responses under 160');
  });

  it('should parse profile with all sections', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_friendly
  PRIORITY: 10
  WHEN: channel.name.startsWith("voice")

  INSTRUCTIONS: |
    Speak naturally.

  CONSTRAINTS:
    - "Response under 500 chars"

  RESPONSE:
    MAX_BUTTONS: 0
    FALLBACK_FORMAT: plain_text
    MAX_RESPONSE_LENGTH: 500

  VOICE:
    INSTRUCTIONS: "Warm tone"

  TOOLS:
    HIDE: [show_carousel, display_map]

  GATHER:
    VALIDATION_STYLE: strict
    CONFIRMATION: always
    FIELD_OVERRIDES:
      email:
        PROMPT: "Spell your email"
        EXTRACTION_HINTS: ["Letter by letter"]

  FLOW:
    SKIP: [pdf_generation, loyalty_lookup]
    OVERRIDE:
      welcome:
        RESPOND: "Hello via voice!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const profile = result.documents[0].behaviorProfile!;
    expect(profile.constraints).toHaveLength(1);
    expect(profile.response?.max_buttons).toBe(0);
    expect(profile.response?.fallback_format).toBe('plain_text');
    expect(profile.voice?.instructions).toBe('Warm tone');
    expect(profile.tools?.hide).toEqual(['show_carousel', 'display_map']);
    expect(profile.gather?.validation_style).toBe('strict');
    expect(profile.gather?.field_overrides?.email?.prompt).toBe('Spell your email');
    expect(profile.flow?.skip).toEqual(['pdf_generation', 'loyalty_lookup']);
    expect(profile.flow?.overrides?.welcome?.respond).toBe('Hello via voice!');
  });

  it('should parse profile with FLOW REPLACE', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice_flow
  PRIORITY: 15
  WHEN: channel.name == "voice"

  FLOW:
    REPLACE: voice_booking_flow
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.documents[0].behaviorProfile!.flow?.replace).toBe('voice_booking_flow');
  });

  it('should parse USE BEHAVIOR_PROFILE in agent documents', () => {
    const dsl = `
AGENT: booking_agent
  GOAL: "Help book hotels"

  USE BEHAVIOR_PROFILE: whatsapp_standard
  USE BEHAVIOR_PROFILE: voice_friendly

  FLOW:
    welcome:
      RESPOND: "Welcome!"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.documents[0];
    expect(doc.useBehaviorProfiles).toEqual(['whatsapp_standard', 'voice_friendly']);
  });

  it('should error on missing PRIORITY', () => {
    const dsl = `
BEHAVIOR_PROFILE: missing_priority
  WHEN: channel.name == "whatsapp"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('PRIORITY');
  });

  it('should error on missing WHEN', () => {
    const dsl = `
BEHAVIOR_PROFILE: missing_when
  PRIORITY: 10
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('WHEN');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/parser/behavior-profile-parser.test.ts`
Expected: FAIL — parser doesn't recognize BEHAVIOR_PROFILE

**Step 3: Add AST types**

In `packages/core/src/types/agent-based.ts`, add:

```typescript
// Behavior Profile AST types
export interface BehaviorProfileAST {
  priority: number;
  when: string;
  instructions?: string;
  constraints?: string[];
  response?: BehaviorProfileResponseAST;
  voice?: { ssml?: string; instructions?: string; plain_text?: string };
  tools?: { hide?: string[]; add?: ToolDefinitionAST[] };
  gather?: BehaviorProfileGatherAST;
  flow?: BehaviorProfileFlowAST;
}

export interface BehaviorProfileResponseAST {
  max_buttons?: number;
  fallback_format?: string;
  media?: string[];
  max_response_length?: number;
}

export interface BehaviorProfileGatherAST {
  validation_style?: string;
  confirmation?: string;
  field_overrides?: Record<
    string,
    {
      prompt?: string;
      extraction_hints?: string[];
      skip?: boolean;
      required?: boolean;
      validation?: string;
    }
  >;
}

export interface BehaviorProfileFlowAST {
  skip?: string[];
  overrides?: Record<
    string,
    { respond?: string; voice?: any; rich_content?: any; transition?: string }
  >;
  insertions?: Array<{ position: 'before' | 'after'; target_step: string; step: any }>;
  replace?: string;
}
```

And add to `AgentBasedDocument`:

```typescript
export interface AgentBasedDocument {
  // ... existing fields ...
  type: 'agent' | 'supervisor' | 'behavior_profile';
  behaviorProfile?: BehaviorProfileAST;
  useBehaviorProfiles?: string[];
}
```

**Step 4: Implement parser logic**

In `packages/core/src/parser/agent-based-parser.ts`, add a `parseBehaviorProfile()` function that handles the BEHAVIOR_PROFILE keyword and its subsections. Also add parsing for `USE BEHAVIOR_PROFILE:` lines within agent documents.

Key implementation points:

- Detect `BEHAVIOR_PROFILE:` at top level (same indentation handling as AGENT/SUPERVISOR)
- Parse PRIORITY as number, WHEN as multiline CEL string
- Reuse existing section parsers where possible (CONSTRAINTS, VOICE sections)
- Parse RESPONSE, GATHER, TOOLS, FLOW as profile-specific subsections
- In agent parsing, detect `USE BEHAVIOR_PROFILE:` lines → collect into `useBehaviorProfiles[]`

**Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/parser/behavior-profile-parser.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/types/agent-based.ts packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser/behavior-profile-parser.test.ts
git commit -m "[ABLP-2] feat(core): parse BEHAVIOR_PROFILE DSL and USE BEHAVIOR_PROFILE references"
```

---

## Phase 3: Compiler — Profile Compilation & Validation

### Task 3.1: Compile BehaviorProfileAST to BehaviorProfileIR

**Files:**

- Create: `packages/compiler/src/platform/ir/compile-behavior-profile.ts`
- Modify: `packages/compiler/src/platform/ir/compiler.ts:157` (integrate into compileABLtoIR)
- Test: `packages/compiler/src/__tests__/ir/compile-behavior-profile.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/ir/compile-behavior-profile.test.ts
import { describe, it, expect } from 'vitest';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

describe('behavior profile compilation', () => {
  it('should compile a profile and attach to agent IR', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: whatsapp_standard
  PRIORITY: 20
  WHEN: channel.name == "whatsapp"
  INSTRUCTIONS: |
    Keep responses short.
  CONSTRAINTS:
    - "Response under 1024 chars"
  TOOLS:
    HIDE: [send_email]
`;
    const agentDsl = `
AGENT: booking_agent
  GOAL: "Help book hotels"
  USE BEHAVIOR_PROFILE: whatsapp_standard
  TOOLS:
    send_email:
      DESCRIPTION: "Send email"
    search_hotels:
      DESCRIPTION: "Search hotels"
`;
    // Parse both documents (assume parser works from Phase 2)
    const { parseAgentBasedABL } = await import('@agent-platform/core');
    const profileParsed = parseAgentBasedABL(profileDsl);
    const agentParsed = parseAgentBasedABL(agentDsl);

    const allDocs = [...profileParsed.documents, ...agentParsed.documents];
    const result = compileABLtoIR(allDocs);

    expect(result.compilationErrors).toHaveLength(0);
    const agentIR = result.agents['booking_agent'];
    expect(agentIR.behavior_profiles).toHaveLength(1);
    expect(agentIR.behavior_profiles![0].name).toBe('whatsapp_standard');
    expect(agentIR.behavior_profiles![0].priority).toBe(20);
    expect(agentIR.behavior_profiles![0].when).toBe('channel.name == "whatsapp"');
    expect(agentIR.behavior_profiles![0].instructions).toContain('Keep responses short');
    expect(agentIR.behavior_profiles![0].tools_hide).toEqual(['send_email']);
  });

  it('should sort profiles by priority on agent IR', () => {
    // Test with two profiles: priority 30 and priority 10
    // Verify they appear sorted ascending in behavior_profiles[]
  });

  it('should emit PROFILE_UNKNOWN_TOOL for invalid TOOLS.HIDE', () => {
    // Profile hides a tool that the agent doesn't declare
    // Expect compilation warning/error
  });

  it('should emit PROFILE_PRIORITY_CONFLICT for duplicate priorities', () => {
    // Two profiles on same agent with same priority
    // Expect compilation error
  });

  it('should emit PROFILE_INVALID_WHEN for bad CEL syntax', () => {
    // Profile with invalid CEL expression
    // Expect compilation error
  });

  it('should emit PROFILE_FLOW_CONFLICT when REPLACE + modifications both set', () => {
    // Profile has both flow_replace and flow_modifications
    // Expect compilation error
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir/compile-behavior-profile.test.ts`
Expected: FAIL — compilation doesn't handle behavior profiles

**Step 3: Implement profile compilation**

Create `packages/compiler/src/platform/ir/compile-behavior-profile.ts`:

```typescript
import type { AgentBasedDocument } from '@agent-platform/core';
import type { BehaviorProfileIR, AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { evaluateCel } from '../constructs/cel-evaluator.js';

export function compileBehaviorProfile(doc: AgentBasedDocument): {
  profile: BehaviorProfileIR;
  errors: ValidationDiagnostic[];
} {
  const errors: ValidationDiagnostic[] = [];
  const ast = doc.behaviorProfile!;

  // Validate WHEN expression is valid CEL
  try {
    // Dry-run parse (not evaluate) the CEL expression
    evaluateCel(ast.when, { channel: { name: '' }, caller: {}, session: {}, env: {} });
  } catch (e) {
    errors.push({
      type: 'validation',
      severity: 'error',
      code: 'PROFILE_INVALID_WHEN',
      message: `Invalid WHEN expression: ${e instanceof Error ? e.message : String(e)}`,
      agentName: doc.name,
    });
  }

  const profile: BehaviorProfileIR = {
    name: doc.name,
    priority: ast.priority,
    when: ast.when,
    instructions: ast.instructions,
    voice: ast.voice,
    constraints: ast.constraints?.map((c) => ({
      condition: c,
      on_fail: { type: 'respond' as const, message: c },
    })),
    tools_hide: ast.tools?.hide,
    // tools_add: compile tool definitions if present
    response_rules: ast.response
      ? {
          max_buttons: ast.response.max_buttons,
          fallback_format: ast.response.fallback_format as any,
          media_types: ast.response.media,
          max_response_length: ast.response.max_response_length,
        }
      : undefined,
    gather_overrides: ast.gather
      ? {
          validation_style: ast.gather.validation_style as any,
          confirmation: ast.gather.confirmation as any,
          field_overrides: ast.gather.field_overrides,
        }
      : undefined,
    flow_modifications: ast.flow?.replace
      ? undefined
      : ast.flow
        ? {
            skip: ast.flow.skip,
            overrides: ast.flow.overrides,
            insertions: ast.flow.insertions,
          }
        : undefined,
    flow_replace: ast.flow?.replace,
  };

  // Validate: can't have both flow_replace and flow_modifications
  if (profile.flow_replace && profile.flow_modifications) {
    errors.push({
      type: 'validation',
      severity: 'error',
      code: 'PROFILE_FLOW_CONFLICT',
      message: `Profile "${doc.name}" has both FLOW REPLACE and FLOW modifications`,
      agentName: doc.name,
    });
  }

  return { profile, errors };
}

export function attachProfilesToAgent(
  agentIR: AgentIR,
  profileNames: string[],
  compiledProfiles: Map<string, BehaviorProfileIR>,
): ValidationDiagnostic[] {
  const errors: ValidationDiagnostic[] = [];
  const attached: BehaviorProfileIR[] = [];
  const priorities = new Set<number>();

  for (const name of profileNames) {
    const profile = compiledProfiles.get(name);
    if (!profile) {
      errors.push({
        type: 'validation',
        severity: 'error',
        code: 'PROFILE_NOT_FOUND',
        message: `Behavior profile "${name}" not found`,
        agentName: agentIR.metadata.name,
      });
      continue;
    }

    // Check priority conflict
    if (priorities.has(profile.priority)) {
      errors.push({
        type: 'validation',
        severity: 'error',
        code: 'PROFILE_PRIORITY_CONFLICT',
        message: `Duplicate priority ${profile.priority} on agent "${agentIR.metadata.name}"`,
        agentName: agentIR.metadata.name,
      });
    }
    priorities.add(profile.priority);

    // Validate tool references
    if (profile.tools_hide) {
      const agentToolNames = new Set(agentIR.tools.map((t) => t.name));
      for (const toolName of profile.tools_hide) {
        if (!agentToolNames.has(toolName)) {
          errors.push({
            type: 'validation',
            severity: 'warning',
            code: 'PROFILE_UNKNOWN_TOOL',
            message: `Profile "${name}" hides unknown tool "${toolName}"`,
            agentName: agentIR.metadata.name,
          });
        }
      }
    }

    // Validate flow step references
    if (profile.flow_modifications && agentIR.flow) {
      const stepNames = new Set(agentIR.flow.steps.map((s) => s.name));
      for (const skipName of profile.flow_modifications.skip ?? []) {
        if (!stepNames.has(skipName)) {
          errors.push({
            type: 'validation',
            severity: 'error',
            code: 'PROFILE_UNKNOWN_STEP',
            message: `Profile "${name}" skips unknown step "${skipName}"`,
            agentName: agentIR.metadata.name,
          });
        }
      }
    }

    attached.push(profile);
  }

  // Sort by priority ascending
  agentIR.behavior_profiles = attached.sort((a, b) => a.priority - b.priority);
  return errors;
}
```

**Step 4: Integrate into compileABLtoIR**

In `packages/compiler/src/platform/ir/compiler.ts`, in the `compileABLtoIR` function (line ~157):

1. Separate documents by type: `behavior_profile` vs `agent`/`supervisor`
2. Compile all behavior profile documents first → `Map<string, BehaviorProfileIR>`
3. After compiling each agent, call `attachProfilesToAgent()` using `doc.useBehaviorProfiles`
4. Collect validation diagnostics

**Step 5: Run tests**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir/compile-behavior-profile.test.ts`
Expected: PASS

**Step 6: Add validation codes**

In `packages/compiler/src/platform/ir/validation-types.ts` (line ~14), add to `VALIDATION_CODES`:

```typescript
PROFILE_PRIORITY_CONFLICT: 'PROFILE_PRIORITY_CONFLICT',
PROFILE_UNKNOWN_STEP: 'PROFILE_UNKNOWN_STEP',
PROFILE_UNKNOWN_TOOL: 'PROFILE_UNKNOWN_TOOL',
PROFILE_INVALID_WHEN: 'PROFILE_INVALID_WHEN',
PROFILE_FLOW_CONFLICT: 'PROFILE_FLOW_CONFLICT',
PROFILE_CIRCULAR_INSERT: 'PROFILE_CIRCULAR_INSERT',
PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
PROFILE_UNUSED: 'PROFILE_UNUSED',
```

**Step 7: Commit**

```bash
git add packages/compiler/src/platform/ir/compile-behavior-profile.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/platform/ir/validation-types.ts packages/compiler/src/__tests__/ir/compile-behavior-profile.test.ts
git commit -m "[ABLP-2] feat(compiler): compile BEHAVIOR_PROFILE to IR with validation"
```

---

## Phase 4: Runtime — Profile Resolver

### Task 4.1: ProfileContext Assembly and Profile Resolution

**Files:**

- Create: `apps/runtime/src/services/execution/profile-resolver.ts`
- Test: `apps/runtime/src/__tests__/profile-resolver.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/profile-resolver.test.ts
import { describe, it, expect } from 'vitest';
import {
  assembleProfileContext,
  resolveActiveProfiles,
  buildEffectiveConfig,
  type ProfileContext,
} from '../services/execution/profile-resolver.js';
import type { AgentIR, BehaviorProfileIR } from '@agent-platform/compiler';

describe('profile-resolver', () => {
  describe('assembleProfileContext', () => {
    it('should assemble context from session and connection data', () => {
      const ctx = assembleProfileContext({
        channelType: 'whatsapp',
        callerContext: {
          tenantId: 't1',
          channel: 'whatsapp',
          identityTier: 1,
          verificationMethod: 'otp',
          customerId: 'cust_123',
        },
        connectionConfig: {
          region: 'BR',
          number_type: 'business',
          provider: 'meta_cloud',
          tags: { department: 'sales' },
        },
        sessionMeta: { isNew: true, language: 'pt-BR', turnCount: 0 },
      });

      expect(ctx.channel.name).toBe('whatsapp');
      expect(ctx.channel.region).toBe('BR');
      expect(ctx.channel.number_type).toBe('business');
      expect(ctx.caller.is_authenticated).toBe(true);
      expect(ctx.caller.customer_id).toBe('cust_123');
      expect(ctx.session.is_new).toBe(true);
    });
  });

  describe('resolveActiveProfiles', () => {
    const makeProfile = (name: string, priority: number, when: string): BehaviorProfileIR => ({
      name,
      priority,
      when,
    });

    it('should return matching profiles sorted by priority ascending', () => {
      const profiles: BehaviorProfileIR[] = [
        makeProfile('voice', 10, 'channel.name == "voice"'),
        makeProfile('whatsapp', 30, 'channel.name == "whatsapp"'),
        makeProfile('anon', 20, 'caller.is_authenticated == false'),
      ];

      const ctx: ProfileContext = {
        channel: {
          name: 'whatsapp',
          region: 'BR',
          number_type: 'business',
          provider: 'meta_cloud',
          tags: {},
          capabilities: { streaming: false, media: true, threading: false, interactive: true },
        },
        caller: {
          identity_tier: 0,
          customer_id: null,
          is_authenticated: false,
          verification_method: 'none',
          tags: {},
        },
        session: { is_new: true, language: 'pt-BR', turn_count: 0 },
        env: { deployment_region: 'us-east-1', timestamp: Date.now() },
      };

      const matched = resolveActiveProfiles(profiles, ctx);
      expect(matched).toHaveLength(2); // whatsapp + anon match; voice doesn't
      expect(matched[0].name).toBe('anon'); // priority 20 first
      expect(matched[1].name).toBe('whatsapp'); // priority 30 second
    });

    it('should return empty array when no profiles match', () => {
      const profiles = [makeProfile('voice', 10, 'channel.name == "voice"')];
      const ctx: ProfileContext = {
        channel: {
          name: 'whatsapp',
          region: '',
          number_type: '',
          provider: '',
          tags: {},
          capabilities: { streaming: false, media: false, threading: false, interactive: false },
        },
        caller: {
          identity_tier: 0,
          customer_id: null,
          is_authenticated: false,
          verification_method: 'none',
          tags: {},
        },
        session: { is_new: true, language: 'en', turn_count: 0 },
        env: { deployment_region: '', timestamp: Date.now() },
      };
      expect(resolveActiveProfiles(profiles, ctx)).toHaveLength(0);
    });
  });

  describe('buildEffectiveConfig', () => {
    it('should append instructions from matching profiles', () => {
      const baseIR = {
        identity: {
          goal: 'Help users',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
        tools: [],
        constraints: { constraints: [], guardrails: [] },
        gather: { fields: [] },
      } as unknown as AgentIR;

      const profiles: BehaviorProfileIR[] = [
        { name: 'p1', priority: 10, when: 'true', instructions: 'Be concise.' },
        { name: 'p2', priority: 20, when: 'true', instructions: 'No markdown.' },
      ];

      const effective = buildEffectiveConfig(baseIR, profiles);
      expect(effective.additionalInstructions).toEqual(['Be concise.', 'No markdown.']);
    });

    it('should remove hidden tools and add new tools', () => {
      const baseIR = {
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
        tools: [
          {
            name: 'send_email',
            description: 'Send email',
            parameters: [],
            returns: { type: 'object' },
            hints: {},
          },
          {
            name: 'search',
            description: 'Search',
            parameters: [],
            returns: { type: 'object' },
            hints: {},
          },
        ],
        constraints: { constraints: [], guardrails: [] },
        gather: { fields: [] },
      } as unknown as AgentIR;

      const profiles: BehaviorProfileIR[] = [
        { name: 'p1', priority: 10, when: 'true', tools_hide: ['send_email'] },
      ];

      const effective = buildEffectiveConfig(baseIR, profiles);
      expect(effective.tools.map((t) => t.name)).toEqual(['search']);
    });

    it('should use highest priority for conflicting overrides', () => {
      const baseIR = {
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
        tools: [],
        constraints: { constraints: [], guardrails: [] },
        gather: { fields: [] },
      } as unknown as AgentIR;

      const profiles: BehaviorProfileIR[] = [
        { name: 'low', priority: 10, when: 'true', response_rules: { max_buttons: 5 } },
        { name: 'high', priority: 20, when: 'true', response_rules: { max_buttons: 3 } },
      ];

      const effective = buildEffectiveConfig(baseIR, profiles);
      expect(effective.responseRules?.max_buttons).toBe(3); // Higher priority wins
    });

    it('should apply flow skip modifications', () => {
      const baseIR = {
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
        tools: [],
        constraints: { constraints: [], guardrails: [] },
        gather: { fields: [] },
        flow: {
          steps: [
            { name: 'welcome', respond: 'Hi' },
            { name: 'loyalty', respond: 'Points?' },
            { name: 'book', respond: 'Booking...' },
          ],
        },
      } as unknown as AgentIR;

      const profiles: BehaviorProfileIR[] = [
        { name: 'p1', priority: 10, when: 'true', flow_modifications: { skip: ['loyalty'] } },
      ];

      const effective = buildEffectiveConfig(baseIR, profiles);
      expect(effective.flow?.steps.map((s) => s.name)).toEqual(['welcome', 'book']);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/profile-resolver.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement profile-resolver.ts**

Create `apps/runtime/src/services/execution/profile-resolver.ts` with:

- `ProfileContext` interface
- `assembleProfileContext()` — builds context from session/connection/caller data
- `resolveActiveProfiles()` — evaluates CEL WHEN expressions, returns sorted matches
- `buildEffectiveConfig()` — applies profiles onto base IR with merge semantics
- Helper functions: `applyGatherOverrides()`, `applyFlowModifications()`

Use `evaluateCelCondition` from `@agent-platform/compiler` for CEL evaluation. Wrap each evaluation in try/catch — a failing CEL expression should log a warning and skip the profile (not crash the session).

**Step 4: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/profile-resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/profile-resolver.ts apps/runtime/src/__tests__/profile-resolver.test.ts
git commit -m "[ABLP-2] feat(runtime): add profile resolver with context assembly and effective config builder"
```

---

### Task 4.2: Integrate Profile Resolution into Runtime Execution

**Files:**

- Modify: `apps/runtime/src/services/execution/prompt-builder.ts:194` (inject additionalInstructions)
- Modify: `apps/runtime/src/services/execution/types.ts:65` (add effectiveConfig to RuntimeSession)
- Modify: `apps/runtime/src/services/queues/inbound-worker.ts` (resolve profiles on session creation)
- Test: `apps/runtime/src/__tests__/profile-integration.test.ts`

**Step 1: Write integration test**

Test that a session with a WhatsApp channel type gets profile-modified system prompt, tools, and constraints.

**Step 2: Add `_effectiveConfig` and `_activeProfileNames` to RuntimeSession**

In `apps/runtime/src/services/execution/types.ts`, add:

```typescript
export interface RuntimeSession {
  // ... existing fields ...
  _activeProfileNames?: string[];
  _effectiveConfig?: EffectiveAgentConfig;
}
```

**Step 3: Call profile resolution in session initialization**

In the inbound worker (or session creation path), after the agent IR is loaded:

```typescript
import { assembleProfileContext, resolveActiveProfiles, buildEffectiveConfig } from './profile-resolver.js';

// After agentIR is available on session:
if (agentIR.behavior_profiles?.length) {
  const profileCtx = assembleProfileContext({
    channelType: session.channelType,
    callerContext: session.callerContext,
    connectionConfig: resolvedConnection?.config,
    sessionMeta: { isNew: true, language: '', turnCount: 0 },
  });
  const activeProfiles = resolveActiveProfiles(agentIR.behavior_profiles, profileCtx);
  session._effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles);
  session._activeProfileNames = activeProfiles.map(p => p.name);

  // Emit trace event
  traceEmitter.emit('profile_resolution', { ... });
}
```

**Step 4: Modify prompt builder to use effective config**

In `buildSystemPrompt()` (line ~194), after building the base prompt, check for `session._effectiveConfig?.additionalInstructions` and append them:

```typescript
if (session._effectiveConfig?.additionalInstructions?.length) {
  parts.push('\n## Channel-Specific Instructions\n');
  for (const instr of session._effectiveConfig.additionalInstructions) {
    parts.push(instr);
  }
}
```

**Step 5: Modify tool resolution to use effective config**

Where tools are collected for the LLM call, use `session._effectiveConfig?.tools ?? agentIR.tools`.

**Step 6: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/profile-integration.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/prompt-builder.ts apps/runtime/src/services/execution/types.ts apps/runtime/src/services/queues/inbound-worker.ts apps/runtime/src/__tests__/profile-integration.test.ts
git commit -m "[ABLP-2] feat(runtime): integrate profile resolution into execution pipeline"
```

---

### Task 4.3: Add profile_resolution Trace Event

**Files:**

- Modify: trace event types (add `profile_resolution` event type)
- Test: `apps/runtime/src/__tests__/trace-profile-resolution.test.ts`

Emit a `profile_resolution` trace event when profiles are resolved, including:

- List of evaluated profiles
- List of matched profiles
- Context snapshot (channel, caller summary)
- Effective overrides summary (counts of instructions appended, tools hidden, etc.)

**Commit:**

```bash
git commit -m "[ABLP-2] feat(runtime): emit profile_resolution trace event"
```

---

## Phase 5: Connection Schema Extension

### Task 5.1: Add Channel Metadata Fields to Connection Config

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:102-114` (extend connection config type)
- Modify: Studio channel connection forms (add region, number_type, provider, tags fields)
- Test: `apps/runtime/src/__tests__/channel-connection-metadata.test.ts`

Add optional fields to channel connection config:

```typescript
interface ChannelConnectionConfig {
  region?: string;
  number_type?: string;
  provider?: string;
  tags?: Record<string, string>;
}
```

These are set by customers in Studio when configuring channel connections. The runtime reads them in `assembleProfileContext()`.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(runtime): extend channel connection config with region, number_type, provider, tags"
```

---

## Phase 6: Project-IO — Import/Export

### Task 6.1: Add Profile Support to Export Pipeline

**Files:**

- Modify: `packages/project-io/src/export/folder-builder.ts:38-104` (add profileFilePath)
- Modify: `packages/project-io/src/export/project-exporter.ts` (include profiles in export)
- Modify: `packages/project-io/src/types.ts:92-108` (add profiles to ProjectManifest)
- Test: `packages/project-io/src/__tests__/export-profiles.test.ts`

**Step 1: Add file path helper**

In `folder-builder.ts`:

```typescript
export function profileFilePath(profileName: string): string {
  return `profiles/${profileName}.behavior_profile.abl`;
}
```

**Step 2: Add ManifestProfile type**

In `types.ts`:

```typescript
export interface ManifestProfile {
  name: string;
  path: string;
  priority: number;
  when_summary: string;
  used_by: string[];
}

export interface ProjectManifest {
  // ... existing ...
  profiles?: Record<string, ManifestProfile>;
}
```

**Step 3: Include profiles in export**

In project exporter, add profiles to the file map and manifest.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(shared): add behavior profile support to project export"
```

### Task 6.2: Add Profile Support to Import Pipeline

**Files:**

- Modify: `packages/project-io/src/import/folder-reader.ts:25-101` (categorize .behavior_profile.abl files)
- Modify: `packages/project-io/src/import/project-importer.ts` (handle profile imports)
- Modify: `packages/project-io/src/__tests__/dependency-extractor.test.ts` (USE BEHAVIOR_PROFILE as dependency edge)
- Test: `packages/project-io/src/__tests__/import-profiles.test.ts`

**Step 1: Update folder reader**

In `readFolder()`, add:

```typescript
if (filename.endsWith('.behavior_profile.abl')) {
  result.profileFiles.push({ name, path, content });
}
```

**Step 2: Update dependency extractor**

Recognize `USE BEHAVIOR_PROFILE: xyz` as a dependency from agent → profile.

**Step 3: Update importer**

Include profiles in diff calculation (added/modified/removed).

**Commit:**

```bash
git commit -m "[ABLP-2] feat(shared): add behavior profile support to project import"
```

---

## Phase 7: Studio — Profile Pages

### Task 7.1: Add Navigation Entry for Behavior Profiles

**Files:**

- Modify: `apps/studio/src/store/navigation-store.ts:15-41` (add 'profiles' to ProjectPage)
- Modify: Studio sidebar component (add Behavior Profiles nav item between Agents and Tools)

Add `'profiles'` to the `ProjectPage` union type and add the nav item with a `Layers` icon from lucide-react.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add Behavior Profiles navigation entry"
```

### Task 7.2: Create Profile Store

**Files:**

- Create: `apps/studio/src/store/profile-store.ts`
- Test: `apps/studio/src/__tests__/profile-store.test.ts`

Zustand store for profile CRUD:

```typescript
interface ProfileStore {
  profiles: ProfileSummary[];
  loading: boolean;
  error: string | null;
  fetchProfiles: (projectId: string) => Promise<void>;
  createProfile: (projectId: string, name: string, dsl: string) => Promise<void>;
  deleteProfile: (projectId: string, name: string) => Promise<void>;
}
```

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add profile store for CRUD operations"
```

### Task 7.3: Create Profile List Page

**Files:**

- Create: `apps/studio/src/components/profiles/ProfileListPage.tsx`
- Create: `apps/studio/src/components/profiles/ProfileCard.tsx`

Grid of cards following AgentListPage patterns. Each card shows:

- Profile name
- Priority badge (accent color)
- Truncated WHEN expression (monospace, `text-xs`)
- "Used by: N agents" count
- Override category chips (instructions, flow, tools, constraints, voice, gather)
- Last updated relative timestamp

Use existing design tokens: `bg-background-muted`, `border-default`, `shadow-sm`, `card-hover` transition.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add ProfileListPage and ProfileCard components"
```

### Task 7.4: Create Profile Detail/Editor Page

**Files:**

- Create: `apps/studio/src/components/profiles/ProfileDetailPage.tsx`
- Create: `apps/studio/src/components/profiles/sections/` (MatchSection, InstructionsSection, etc.)

Section-centric accordion layout matching AgentDetailPage conventions. Each section is a collapsible card with form inputs. Raw DSL toggle overlay for direct editing.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add ProfileDetailPage with section editors"
```

### Task 7.5: Add Profile Serializer

**Files:**

- Modify: `apps/studio/src/lib/abl-serializers.ts` (add serializeProfileToABL)
- Test: `apps/studio/src/__tests__/profile-serializer.test.ts`

```typescript
export function serializeProfileToABL(data: ProfileData): string {
  // Serialize BEHAVIOR_PROFILE with all sections
}
```

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add behavior profile ABL serializer"
```

---

## Phase 8: Studio — Agent Detail BEHAVIOR Section

### Task 8.1: Add BEHAVIOR Section to Agent Detail Page

**Files:**

- Modify: `apps/studio/src/store/agent-detail-store.ts:20-27` (add 'BEHAVIOR' to SectionId)
- Create: `apps/studio/src/components/agent-detail/BehaviorSection.tsx`

New accordion section showing attached profiles as inline cards with:

- Profile name, priority, WHEN clause summary
- Override category chips
- View (link to profile detail) and Remove buttons
- Add button (dropdown of available project profiles)

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add BEHAVIOR section to agent detail page"
```

### Task 8.2: Add USE BEHAVIOR_PROFILE Serialization

**Files:**

- Modify: `apps/studio/src/lib/abl-serializers.ts` (add serializeBehaviorRefsToABL)

When the BEHAVIOR section changes, serialize `USE BEHAVIOR_PROFILE:` lines into the agent DSL.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): serialize USE BEHAVIOR_PROFILE references"
```

---

## Phase 9: Arch AI Integration

### Task 9.1: Extend Arch Context Builder for Profiles

**Files:**

- Modify: `apps/studio/src/lib/arch-context-builder.ts:34-134` (include behavior_profiles in context)

Add `behavior_profiles` to `ArchAgentContext` and include them in `formatContextForLLM()`.

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): include behavior profiles in Arch AI context"
```

### Task 9.2: Add Profile-Aware Quick Actions

**Files:**

- Modify: Arch panel quick actions (add profile suggestions when on agents/profiles pages)

Add context-aware actions:

- On agents page: "Add channel support" → suggests creating a profile
- On profiles page: "Suggest profiles", "Audit coverage"

**Commit:**

```bash
git commit -m "[ABLP-2] feat(studio): add profile-aware Arch quick actions"
```

---

## Phase 10: End-to-End Tests

### Task 10.1: E2E — Profile Compilation and Runtime Resolution

**Files:**

- Test: `apps/runtime/src/__tests__/behavior-profile.e2e.test.ts`

Full integration test:

1. Parse agent + profile DSL
2. Compile to IR
3. Verify profile attached to AgentIR
4. Create mock session with WhatsApp channel context
5. Resolve profiles
6. Verify effective config has modified instructions, tools, constraints
7. Build system prompt and verify profile instructions included
8. Verify trace event emitted

**Commit:**

```bash
git commit -m "[ABLP-2] test(runtime): add behavior profile end-to-end test"
```

### Task 10.2: E2E — Import/Export Round-Trip

**Files:**

- Test: `packages/project-io/src/__tests__/profile-roundtrip.test.ts`

Export project with profiles → import into fresh project → verify profiles preserved with correct agent references.

**Commit:**

```bash
git commit -m "[ABLP-2] test(shared): add behavior profile import/export round-trip test"
```

---

## Implementation Order Summary

| Phase                | Tasks         | Est. Complexity | Dependencies |
| -------------------- | ------------- | --------------- | ------------ |
| 1. IR Types          | 1.1           | Low             | None         |
| 2. Parser            | 2.1           | Medium          | Phase 1      |
| 3. Compiler          | 3.1           | Medium          | Phase 1, 2   |
| 4. Runtime           | 4.1, 4.2, 4.3 | High            | Phase 1, 3   |
| 5. Connection Schema | 5.1           | Low             | Phase 4      |
| 6. Project-IO        | 6.1, 6.2      | Medium          | Phase 2      |
| 7. Studio Pages      | 7.1-7.5       | Medium          | Phase 2, 3   |
| 8. Agent Detail      | 8.1, 8.2      | Low             | Phase 7      |
| 9. Arch AI           | 9.1, 9.2      | Low             | Phase 7      |
| 10. E2E Tests        | 10.1, 10.2    | Medium          | All above    |

**Parallelizable:** Phases 6 + 7 can run in parallel with Phase 4 (different packages). Phase 9 can run in parallel with Phase 5.
