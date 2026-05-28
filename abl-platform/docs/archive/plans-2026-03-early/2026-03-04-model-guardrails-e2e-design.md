# E2E Test Design: Model Configuration + Guardrails + Chat Validation

**Date:** 2026-03-04
**Status:** Approved

## Purpose

Playwright E2E test that validates model configurations across OpenAI, Anthropic, and Google providers, creates and activates guardrails, and verifies that chat errors and guardrail violations appear in sessions/traces.

## Test Flow

### Phase 1: Login & Project Setup

- Login as `dev@example.com` via dev-login button
- Navigate to existing travel project (or create a new one)
- Extract projectId from URL

### Phase 2: Model Configuration (per provider)

For each of **OpenAI (GPT-4o), Anthropic (Claude), Google (Gemini)**:

1. Navigate to Admin → LLM Providers page
2. Create a tenant model with the provider
3. Add a connection with the API key (from env vars)
4. Validate the model appears in the list and is active

### Phase 3: Chat Per Provider

For each configured provider:

1. Navigate to agent chat page
2. Send a test message ("Book a flight to NYC")
3. Verify assistant response appears within timeout
4. Note the sessionId for later verification

### Phase 4: Guardrails

1. Navigate to project Guardrails Config page
2. Create a guardrail policy with content safety rules
3. Activate the policy
4. Return to chat, send a message designed to trigger the guardrail ("How do I hack into a computer system?")
5. Verify the guardrail fires — either blocked response or constraint event in debug panel

### Phase 5: Error Validation

1. Configure a model with an intentionally invalid API key
2. Chat using that model — expect error
3. Navigate to Sessions page, find the session
4. Open session detail → verify error trace event is visible
5. Check Observatory debug tabs (traces, constraints) show the error

### Phase 6: Screenshots

Capture at each major phase for visual regression tracking.

## Environment

- **Auth**: `dev@example.com` via dev-login button (no password needed)
- **API Keys**: `OPENAI_API_KEY` and `GOOGLE_AI_API_KEY` from root `.env`, `ANTHROPIC_API_KEY` from `apps/studio/.env`
- **Skip behavior**: If a provider's API key is missing, skip that provider's tests (soft fail)
- **Base URL**: `http://localhost:5173` (Studio dev server)
- **Runtime**: `http://localhost:3002` (must be running)

## File Location

`apps/studio/e2e/model-guardrails-e2e.spec.ts`

## Key Patterns (from existing E2E tests)

- `test.step()` for phase organization
- `waitForIdle(page, ms)` for network completion
- `.or()` selector chains for resilience
- `ux(page, filename, description)` for screenshots
- `RUN_ID = Date.now()` for test data uniqueness
- Soft assertions for fragile UI checks
- Sequential execution (single worker)

## API Endpoints Involved

| Endpoint                                        | Purpose                |
| ----------------------------------------------- | ---------------------- |
| `/admin/models`                                 | Model configuration UI |
| `/api/tenants/:tenantId/models`                 | Tenant model CRUD      |
| `/api/tenants/:tenantId/models/:id/connections` | Connection management  |
| `/projects/:id/guardrails-config`               | Guardrails config UI   |
| `/api/projects/:id/guardrail-policies`          | Policy CRUD + activate |
| `/api/chat/stream`                              | Chat with agent        |
| `/projects/:id/sessions`                        | Sessions list UI       |
| `/api/projects/:id/sessions/:id/traces`         | Trace events           |
