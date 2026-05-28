# Feature: Voice Provider Registry and Capability Matrix

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `integrations`, `customer experience`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/config`
**Owner(s)**: Platform Engineering
**Testing Guide**: [`../../testing/sub-features/voice-provider-registry.md`](../../testing/sub-features/voice-provider-registry.md)
**Last Updated**: 2026-04-22

---

## 1. Introduction / Overview

### Problem Statement

ABL currently hardcodes voice provider lists and labels in several places:

- Studio admin voice-service cards
- Studio speech-provider filtering for channel configuration
- Studio S2S selector labels and config dispatch
- Runtime tenant service-instance validation and speech-role helpers
- Runtime S2S provider type unions

Those lists do not stay in sync. Repo evidence today shows drift such as:

- `apps/studio/src/components/admin/VoiceServicesPage.tsx` carrying its own STT/TTS card lists
- `apps/studio/src/api/speech-providers.ts` allowing provider types that the runtime CRUD route does not expose
- `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` and `S2SConfigFields.tsx` duplicating S2S labels and routing
- `apps/runtime/src/routes/tenant-service-instances.ts` keeping a separate service-type allowlist and speech-role map

This makes provider expansion risky and causes Studio to overstate support on some paths. The first parity story for KoreVG-backed voice support needs a canonical provider matrix before adding more vendors.

### Goal Statement

Create one repository-backed voice provider registry that defines the current ABL provider surface, capability flags, and shared labels. Studio and runtime consumers should derive their lists and validation from this registry instead of maintaining separate hardcoded copies.

### Summary

This sub-feature introduces a canonical voice-provider capability matrix for ABL. It centralizes service types, S2S provider types, speech-provider filtering, preview support, runtime CRUD allowlists, and telephony realtime support status. Studio continues to own presentational details such as icons and field components, but those are driven from the shared provider metadata instead of ad hoc lists.

The change is intentionally scoped to registry/refactor work. It does not add new providers or complete missing runtime parity for partial S2S providers.

---

## 2. Scope

### Goals

- Define the current ABL voice-provider matrix in one shared source of truth
- Expose typed lists for Studio and runtime consumers
- Remove duplicated provider labels and service-type allowlists where practical
- Add capability flags that let Studio distinguish full versus partial S2S telephony support
- Keep existing credential storage and channel UX intact while reducing provider drift

### Non-Goals (Out of Scope)

- Adding new STT, TTS, or S2S vendors beyond what ABL already models
- Implementing missing provider-specific realtime runtime builders
- Changing tenant-service-instance persistence, encryption, or auth-profile flows
- Redesigning the Voice Services page UX
- Replacing provider-specific S2S config components with a fully schema-driven form system

---

## 3. User Stories

1. As a tenant admin, I want Studio to show one consistent set of voice providers so that the Admin and channel surfaces do not contradict each other.
2. As a deployment author, I want the S2S selector to indicate when a provider is only partially supported in telephony so that I do not mistake credential setup for full runtime parity.
3. As a platform engineer, I want to update provider metadata in one place so that adding or refining providers does not require chasing multiple duplicated lists.

---

## 4. Functional Requirements

1. **FR-1**: The system must define a canonical voice-provider registry that covers the currently modeled ABL voice service types and S2S providers.
2. **FR-2**: The system must expose typed helper lists from that registry for runtime service-instance validation, Studio speech-provider filtering, and Studio S2S provider typing.
3. **FR-3**: The system must derive Studio S2S labels from the canonical registry instead of a component-local hardcoded map.
4. **FR-4**: The system must derive Studio speech-provider filtering for STT and TTS channel dropdowns from the canonical registry instead of component-local hardcoded arrays.
5. **FR-5**: The system must derive the runtime tenant service-instance allowlist from the canonical registry instead of a route-local hardcoded list.
6. **FR-6**: The system must derive runtime speech-role helpers from the canonical registry instead of a route-local switch where possible.
7. **FR-7**: The system must model provider capabilities that differentiate admin configuration, channel selection, TTS preview support, and S2S telephony runtime support.
8. **FR-8**: The system must surface a user-visible partial-support indicator for S2S providers whose ABL telephony runtime support is not yet complete.
9. **FR-9**: The system must preserve existing tenant and project isolation behavior for service-instance CRUD and channel configuration.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                          |
| Agent lifecycle            | NONE         | No agent compilation or model routing changes                         |
| Customer experience        | SECONDARY    | Better provider clarity in voice setup surfaces                       |
| Integrations / channels    | PRIMARY      | Channel config speech-provider and S2S selector use the registry      |
| Observability / tracing    | NONE         | No trace event shape changes                                          |
| Governance / controls      | SECONDARY    | Capability flags prevent Studio from overstating support              |
| Enterprise / compliance    | NONE         | No new secrets or compliance flows                                    |
| Admin / operator workflows | PRIMARY      | Voice Services page derives supported providers from one shared model |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                                                | Key Touchpoints                                       | Current State |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| [Voice Capabilities](../voice-capabilities.md) | extends           | This is control-plane cleanup for the existing voice provider surface                         | Voice Services, S2S selector, speech provider filters | ALPHA         |
| [Channels](../channels.md)                     | configured by     | Voice channel configuration consumes STT/TTS/S2S provider metadata                            | `ConfigurationTab.tsx`, channel connection forms      | ALPHA         |
| [Auth Profiles](../auth-profiles.md)           | configured by     | Provider cards still depend on existing tenant credential storage and auth-profile resolution | Voice Services admin flow                             | BETA          |

---

## 6. Design Considerations (Optional)

The goal is a registry refactor, not a visual redesign. Studio should preserve the existing cards and provider-specific config components. Capability messaging should be concise and only appear where it reduces incorrect expectations, especially in S2S telephony setup.

---

## 7. Technical Considerations (Optional)

- A shared config package is the safest home for the canonical provider matrix because both Studio and runtime already import `@agent-platform/config`.
- Studio-specific card fields, icons, and S2S field components should remain in Studio, but their service-type wiring should depend on the shared registry.
- This work should not force runtime parity decisions. Capability flags should document partial support without pretending it is complete.

---

## 8. How to Consume

### Studio UI

- **Admin → Voice Services** reads provider groupings and capability flags from the registry.
- **Channels → Voice Pipeline** uses the registry to filter configured STT and TTS providers.
- **Channels → Voice Realtime (S2S)** uses the registry for provider labels and partial-support messaging.

### Surface Semantics Matrix

| Asset / Entity Type     | Source of Truth / Ownership | Design-Time Surface(s)                                  | Editable or Read-Only?         | Consumer Reference / Binding Model     | Runtime Materialization / Resolution                    | Notes / Unsupported State                              |
| ----------------------- | --------------------------- | ------------------------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Voice provider metadata | Shared config registry      | Studio admin, Studio channel config, runtime validation | Read-only in product surfaces  | Referenced by `serviceType` string     | Used to derive validation, labels, and capability hints | Does not itself create credentials or runtime sessions |
| Voice service instances | Runtime + MongoDB           | Admin Voice Services, channel provider pickers          | Editable through existing CRUD | Bound by `serviceType` and instance ID | Resolved via existing voice-service factory/repo paths  | Persistence model is unchanged                         |

### Design-Time vs Runtime Behavior

The registry is design-time metadata only. It does not replace runtime credential resolution or provider-specific behavior. Runtime still resolves tenant service instances and S2S credentials through the existing service factory; the registry only defines which providers ABL recognizes and how Studio/runtime classify them.

### API (Runtime)

| Method   | Path                                           | Purpose                                                                                              |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/tenants/:tenantId/service-instances`     | Lists configured service instances; registry-backed allowlists keep service-type handling consistent |
| `POST`   | `/api/tenants/:tenantId/service-instances`     | Creates supported service instances using registry-backed validation                                 |
| `PATCH`  | `/api/tenants/:tenantId/service-instances/:id` | Updates existing service instances                                                                   |
| `DELETE` | `/api/tenants/:tenantId/service-instances/:id` | Deletes existing service instances                                                                   |

### API (Studio)

| Method | Path                     | Purpose                                                        |
| ------ | ------------------------ | -------------------------------------------------------------- |
| `GET`  | `/api/service-instances` | Studio proxy used by voice settings and channel configuration  |
| `GET`  | `/api/speech-options`    | Fetches provider voice/language metadata for supported vendors |

### Admin Portal

Admin Voice Services remains the credential-entry surface. This feature only changes how provider cards and readiness calculations are sourced.

### Channel / SDK / Voice / A2A / MCP Integration

Only voice channel configuration is in scope. There are no SDK, A2A, or MCP contract changes.

---

## 9. Data Model

### Collections / Tables

No schema changes. Existing `TenantServiceInstance` documents remain the source of truth for tenant-scoped provider credentials.

### Key Relationships

- `TenantServiceInstance.serviceType` must match a registry-defined runtime service type
- Channel voice configuration references configured service instances through the existing `serviceType` and instance-ID flow

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                               | Purpose                                            |
| -------------------------------------------------- | -------------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts` | Canonical provider registry and capability helpers |

### Routes / Handlers

| File                                                  | Purpose                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Runtime service-type validation and speech-role helpers driven by the registry |

### UI Components

| File                                                                      | Purpose                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`                  | Admin card grouping and readiness status             |
| `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` | Registry-backed labels and partial-support messaging |
| `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`     | Registry-backed S2S config routing                   |
| `apps/studio/src/api/speech-providers.ts`                                 | Registry-backed STT/TTS filtering                    |

### Jobs / Workers / Background Processes

| File | Purpose                     |
| ---- | --------------------------- |
| N/A  | No background work in scope |

### Tests

| File                                                                     | Type        | Coverage Focus                                         |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------ |
| `packages/config/src/__tests__/voice-providers.test.ts`                  | unit        | Registry helper outputs and capability matrix          |
| `apps/studio/src/__tests__/speech-providers.test.ts`                     | unit        | Registry-backed STT/TTS filtering                      |
| `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`               | unit        | S2S labels and partial-support messaging               |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts` | integration | Runtime route still accepts the expected service types |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                  |
| -------- | ------- | ---------------------------- |
| N/A      | N/A     | No new environment variables |

### Runtime Configuration

No new runtime config. The registry is static source metadata committed in the repo.

### DSL / Agent IR / Schema

No DSL or Agent IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Project isolation | Channel configuration continues to respect existing project-scoped access rules.                 |
| Tenant isolation  | Runtime service-instance CRUD remains tenant-scoped and must keep returning non-leaky responses. |
| User isolation    | No new user-owned resource paths are introduced.                                                 |

### Security & Compliance

This feature does not change credential storage, encryption, or auth-profile resolution. It only changes how service types and capabilities are cataloged in code.

### Performance & Scalability

The registry is in-memory static metadata. It slightly reduces repeated conditional logic and has negligible runtime cost.

### Reliability & Failure Modes

The main risk is accidental provider drift during refactor. Tests must cover the shared helper outputs and the existing runtime CRUD behavior.

### Observability

No new traces or metrics are required. If a provider is marked partial, that is surfaced in Studio rather than logs.

### Data Lifecycle

No retention or TTL changes.

---

## 13. Delivery Plan / Work Breakdown

1. Define a shared provider registry in `packages/config`
   1.1 Add typed provider lists for runtime service types, channel STT/TTS types, and S2S types
   1.2 Add a capability matrix covering admin visibility, preview support, and telephony S2S support
2. Refactor Studio consumers to use the registry
   2.1 Update Voice Services page provider grouping and readiness logic
   2.2 Update speech-provider filtering for channel STT/TTS selectors
   2.3 Update S2S labels and partial-support messaging
3. Refactor runtime service-instance validation to use the registry
   3.1 Replace duplicated runtime service-type allowlists
   3.2 Replace duplicated speech-role helpers with registry-backed helpers
4. Lock behavior with focused tests
   4.1 Add shared-registry tests
   4.2 Update Studio filtering tests
   4.3 Add a selector test for capability messaging

---

## 14. Success Metrics

- Provider lists are defined in one shared source and consumed by Studio and runtime
- No component-local S2S label map or route-local runtime allowlist remains for the covered paths
- Studio shows an explicit partial-support message for S2S providers that lack full telephony parity
- Shared-config tests and focused Studio verification pass; runtime package-wide verification remains partially blocked by unrelated workspace module-resolution issues in this worktree

---

## 15. Open Questions

1. Should partial S2S providers remain selectable with a warning, or should a later story hard-block them in telephony authoring?
2. Should future provider-expansion stories move provider-specific field metadata into a schema-driven renderer, or is a Studio-only registry extension sufficient?

---

## 16. Gaps, Known Issues & Limitations

- The registry can describe partial S2S support, but it does not itself implement missing runtime parity for providers like `s2s:elevenlabs`, `s2s:deepgram`, or `s2s:ultravox`.
- Some pipeline provider capabilities still depend on legacy/runtime-specific behavior outside this story.
- Full `apps/runtime` package verification in this worktree still encounters unrelated workspace module-resolution failures outside the touched files. The story verification therefore relies on shared-config tests, focused Studio tests, filtered touched-file typechecks, and a runtime route regression update.

---

## 17. Testing & Validation

Implemented coverage includes shared-config unit coverage, Studio filtering coverage, and a focused Studio selector test for partial-support messaging. Runtime route regression coverage was updated for the registry-backed allowlist, but package-wide runtime execution remains partially blocked by unrelated workspace module-resolution issues in this worktree. Full voice E2E parity remains out of scope for this registry story and belongs to later provider-expansion stories.
