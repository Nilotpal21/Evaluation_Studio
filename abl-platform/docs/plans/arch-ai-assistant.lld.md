# Arch AI Assistant — Low-Level Design

> **Status**: SUPERSEDED by v0.3 design docs
> **v0.3 Implementation Plan**: `docs/arch/09-implementation-plan.md`
> **v0.3 Feature Specs**: `docs/arch/features/` (75 per-feature specs)
> **v0.3 Contracts**: `docs/arch/contracts/` (13 deterministic contracts)

## Phase 1: Core Chat Infrastructure (DONE — v2, superseded)

### Exit Criteria

- Chat panel renders and accepts messages
- Messages are sent to the backend and responses displayed
- Context-aware quick actions appear based on current page

### Key Files

- `apps/studio/src/components/arch/ArchPanel.tsx` — Main panel
- `apps/studio/src/components/arch/ArchChat.tsx` — Chat interface
- `apps/studio/src/components/arch/ArchMessage.tsx` — Message rendering
- `apps/studio/src/store/arch-store.ts` — Zustand store
- `apps/studio/src/app/api/arch/chat/route.ts` — Chat API endpoint
- `apps/studio/src/services/arch.service.ts` — Backend service

### Dependencies

- `@abl/compiler` for ABL compilation and IR extraction
- External LLM provider (OpenAI, Anthropic) configured via admin settings
- `next-intl` for i18n support

---

## Phase 2: Workflow State Machine (DONE)

### Exit Criteria

- Five-state workflow (idle, contextualizing, responding, confirming, executing) functions correctly
- Users can confirm, reject, or refine proposed modifications
- Diff previews display correctly with apply/reject actions

### Key Files

- `apps/studio/src/components/arch/ArchDiffView.tsx` — Diff rendering
- `apps/studio/src/components/arch/PlanMessage.tsx` — Plan message UI
- `apps/studio/src/components/arch/ProposalMessage.tsx` — Proposal message UI
- `apps/studio/src/types/arch.ts` — WorkflowState, ArchProposal, ArchAction types

### Subtasks

1. ST-2.1: Implement workflow state transitions in arch-store
2. ST-2.2: Build ArchDiffView component for diff previews
3. ST-2.3: Wire confirm/reject/refine buttons to workflow actions
4. ST-2.4: Add plan and proposal message types

---

## Phase 3: Project Onboarding Wizard (DONE)

### Exit Criteria

- Seven-phase onboarding flow (welcome, interview, upload, generating, reveal, review, create) works end-to-end
- Users can generate a complete project from a brief description
- Generated agents are saved to the project

### Key Files

- `apps/studio/src/components/onboarding/ArchOnboarding.tsx` — Orchestrator
- `apps/studio/src/components/onboarding/WelcomePhase.tsx` — Templates and entry
- `apps/studio/src/components/onboarding/InterviewPhase.tsx` — Brief collection
- `apps/studio/src/components/onboarding/UploadPhase.tsx` — Document upload
- `apps/studio/src/components/onboarding/GeneratingPhase.tsx` — Progress UI
- `apps/studio/src/components/onboarding/RevealPhase.tsx` — Topology reveal
- `apps/studio/src/components/onboarding/ReviewPhase.tsx` — Agent review
- `apps/studio/src/components/onboarding/CreatePhase.tsx` — Project creation
- `apps/studio/src/store/lifecycle-store.ts` — Phase state management
- `apps/studio/src/app/api/arch/generate/route.ts` — Generation pipeline

### Dependencies

- `apps/studio/src/app/api/arch/chat/route.ts` — For interview phase chat
- Compiler for ABL validation during create phase

---

## Phase 4: Section-Level Editing (DONE)

### Exit Criteria

- When editing a specific agent section (IDENTITY, TOOLS, GATHER, FLOW, RULES, COORDINATION, LIFECYCLE), Arch provides scoped suggestions
- Section edit context indicator appears in panel header
- Chat API receives section context and provides relevant responses

### Key Files

- `apps/studio/src/types/arch.ts` — ArchEditContext, AgentSectionId
- `apps/studio/src/store/arch-store.ts` — editContext management
- `apps/studio/src/components/arch/ArchPanel.tsx` — Section context indicator and scoped suggestions

---

## Phase 5: Admin Configuration (DONE)

### Exit Criteria

- Admins can configure AI provider, model, and API key
- Status endpoint shows configuration health
- API key validation works before saving

### Key Files

- `apps/studio/src/app/api/arch/config/route.ts` — Config CRUD
- `apps/studio/src/app/api/arch/status/route.ts` — Health check
- `apps/studio/src/app/api/arch/validate-key/route.ts` — Key validation
- `apps/studio/src/app/api/arch/models/route.ts` — Model listing
- `apps/studio/src/store/arch-config-store.ts` — Client config store

---

## Phase 6: Cross-Module Integration (DONE)

### Exit Criteria

- Evals "Fix in Architect" button opens Arch with prefilled message
- Arch detects agent edits and triggers data reload in other components
- Conversation persistence works across sessions

### Key Files

- `apps/studio/src/store/arch-store.ts` — prefillMessage, lastAgentEditTimestamp
- `apps/studio/src/api/arch.ts` — loadArchConversation, saveArchConversation

---

## Phase 7: Testing Hardening (OPEN)

### Exit Criteria

- Workflow state machine has dedicated unit tests
- Chat route validation has coverage
- Full onboarding E2E test exists
- Rate limiting is tested

### Suggested New Test Files

- `apps/studio/src/__tests__/arch-workflow-state.test.ts` — State transitions
- `apps/studio/src/__tests__/arch-chat-route.test.ts` — Route validation
- `apps/studio/src/__tests__/arch-onboarding-e2e.test.ts` — Full onboarding flow
- `apps/studio/src/__tests__/arch-rate-limit.test.ts` — Rate limiting
