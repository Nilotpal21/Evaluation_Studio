# Knowledge Graph UX Redesign — High-Level Design

## What

Redesign the Knowledge Graph first-visit experience to eliminate unnecessary steps when LLM models are already configured, and add environment-level awareness when Neo4j is not provisioned. Currently, users with models configured must click through 4 screens (model selection → domain picker → configure → wait) before seeing any value. The redesign collapses this to 2 steps (domain picker → wait) by auto-assigning the recommended model, and adds a "not deployed" state that explains KG value when Neo4j is absent — keeping the feature discoverable instead of hidden.

## Architecture Approach

### Packages That Change

| Package          | What Changes                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai` | Extend `GET /kg-configuration-status` to include `environment.available` flag from server config                                                                                                                                                      |
| `apps/studio`    | Redesign KG tab state machine (4 states), extend `IntelligenceCard` with `not-deployed` state, update `KnowledgeGraphCard` hub card, add new `KGNotDeployedCard` and `KGOnboardingCard` components, remove `KGConfigurationWizard` usage, update i18n |
| `packages/i18n`  | Add ~15 new i18n keys for not-deployed and onboarding states                                                                                                                                                                                          |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Studio (Browser)                                                │
│                                                                 │
│  KnowledgeGraphTab                                              │
│    │                                                            │
│    ├─ useSWR → GET /api/search-ai/indexes/:id/                  │
│    │           kg-configuration-status                          │
│    │                                                            │
│    ▼                                                            │
│  Response now includes:                                         │
│  {                                                              │
│    environment: { available: bool },        ◄── NEW             │
│    configurationLevel: 'workspace'|'tenant'|'none',             │
│    autoConfigureModelId: string|null,       ◄── NEW             │
│    ...existing fields                                           │
│  }                                                              │
│    │                                                            │
│    ├─ !environment.available                                    │
│    │   → KGNotDeployedCard (info + value prop)                  │
│    │                                                            │
│    ├─ configurationLevel === 'none'                              │
│    │   → KGOnboardingCard mode="no-models"                      │
│    │     (value prop + "Configure Models" link)                 │
│    │                                                            │
│    ├─ no taxonomy                                               │
│    │   → KGOnboardingCard mode="ready"                          │
│    │     (auto-model chip + inline domain picker)               │
│    │     On domain select → POST /kg-taxonomy/setup             │
│    │       with autoConfigureModelId (backend auto-configures   │
│    │       model as part of setup if not yet configured)        │
│    │                                                            │
│    └─ has taxonomy                                              │
│        → KGWorkingExperience (graph/stats/attributes)           │
│          [unchanged from current]                               │
└─────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **Backend config → API response**: `getConfig().knowledgeGraph.enabled` exposed via existing endpoint (no new route)
2. **Auto-model assignment**: `POST /kg-taxonomy/setup` gains optional auto-configure behavior — if KG model not yet set on index, uses `autoConfigureModelId` from status endpoint to set it before starting taxonomy job
3. **Hub card ↔ Tab consistency**: Both `KnowledgeGraphCard` and `KnowledgeGraphTab` consume the same `kg-configuration-status` response; hub card gets new `not-deployed` and `pending` states
4. **IntelligenceCard extension**: New `not-deployed` state added to `IntelligenceCardState` union

## Decisions & Tradeoffs

| #   | Decision                                                            | Chose                                                     | Over                                                     | Because                                                                                                  |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Show KG tab when Neo4j not provisioned                              | Show with "Not Deployed" card                             | Hide tab entirely                                        | Discoverability drives adoption; enterprise users need to see what's available to request infrastructure |
| 2   | Auto-assign recommended model                                       | Auto-assign, show as chip with `[change]` link            | Keep model selection wizard                              | System already scores and recommends; forcing manual selection adds zero user value in >90% of cases     |
| 3   | Extend existing endpoint                                            | Add `environment` field to `kg-configuration-status`      | New `/kg-feature-status` endpoint                        | One call, one response, one source of truth. Frontend already calls this — just add a field              |
| 4   | Collapse model config into taxonomy setup                           | `POST /kg-taxonomy/setup` auto-configures model if needed | Keep separate `POST /kg-configure-model` step            | Reduces API calls from 2 to 1 for the common path; explicit configure-model still works for power users  |
| 5   | Single onboarding component for both "no models" and "ready" states | One `KGOnboardingCard` with mode prop                     | Separate `KGConfigureModelsCard` + `KGTaxonomySetupCard` | Same visual structure (explanation + action), just different action area. Reduces component count        |
| 6   | Keep tab visible in sub-nav always                                  | Always show, add subtle indicator for not-deployed        | Conditionally hide/show                                  | Consistent navigation — tabs don't appear/disappear based on infra state                                 |

## Task Decomposition

| Task | Package(s)                     | Independent?                  | Est. Files | Description                                                                                                                                                                                           |
| ---- | ------------------------------ | ----------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `apps/search-ai`               | Yes                           | 2          | Extend `kg-configuration-status` endpoint to include `environment.available` and `autoConfigureModelId`. Extend `kg-taxonomy/setup` to auto-configure model when not yet set.                         |
| T-2  | `apps/studio`, `packages/i18n` | No (needs T-1 response shape) | 6-8        | Create `KGNotDeployedCard`, redesign `KGOnboardingCard` (replaces wizard + taxonomy setup for first visit), update `KnowledgeGraphTab` state machine to 4 states, update `KGConfigurationStatus` type |
| T-3  | `apps/studio`                  | No (needs T-2 types)          | 3          | Extend `IntelligenceCard` with `not-deployed` state, update `KnowledgeGraphCard` hub card to 5-state logic, add tab indicator support                                                                 |
| T-4  | `packages/i18n`                | Yes                           | 1          | Add all new i18n keys for not-deployed, onboarding, and hub card states                                                                                                                               |

Note: T-1 and T-4 are independent and can be parallelized. T-2 depends on T-1's response shape. T-3 depends on T-2's new types/components.

## Out of Scope

- **Taxonomy management/settings panel** (changing model or domain after setup) — separate enhancement
- **Auto-domain inference** from KB content — future intelligence feature
- **KG preview/sample mode** before committing to a taxonomy — complex, separate feature
- **Neo4j health monitoring** — the env flag is a config check, not a runtime connectivity check
- **Changes to the working experience** (graph/stats/attributes views) — already functional
- **Removing `KGConfigurationWizard`/`KGModelSelectionCard`/`KGWorkspaceInheritanceCard` files** — they become unused but deletion is a separate cleanup commit
