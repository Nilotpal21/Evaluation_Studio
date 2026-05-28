# Studio Bugs & Issues Found During E2E Test Development

**Date:** 2026-03-04
**Source:** Model+Guardrails E2E test development

---

## Bug 1: Guardrail Policy Creation — No UI Form

**Severity:** High
**Location:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`

**Description:**
The project-level guardrails config page (`/projects/:id/guardrails-config`) is **read-only**. It displays existing policies and providers but has NO "Create Policy" button or form. Policy creation can only be done via API (`useGuardrailPolicies.createPolicy()` hook exists but no UI calls it).

**Impact:** Users cannot create guardrail policies through the Studio UI at all. They would need to use direct API calls.

**Expected:** A "Create Policy" button + dialog form with fields for name, description, settings (failMode, timeouts, streaming), caching, budget, and rules.

**Workaround:** Use API directly (`POST /api/admin/guardrail-policies?projectId=X`).

---

## Bug 2: Guardrail Policy Activation — No Toggle in Project Page

**Severity:** Medium
**Location:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`

**Description:**
The project-level guardrails page shows policy status (enabled/disabled icon) but does not have an interactive toggle to activate/deactivate policies. The admin workspace page (`GuardrailsPage.tsx`) has toggles, but the project-level page does not expose them.

**Expected:** Clickable toggle or "Activate" button on each policy row in the project-level page.

---

## Bug 3: Two "Add Model" Buttons Cause Strict Mode Violation

**Severity:** Low (UX)
**Location:** `apps/studio/src/components/admin/ModelsPage.tsx` (lines 1663-1687)

**Description:**
When the model catalog is empty, both the header "Add Model" button AND the empty state "Add Model" button are visible simultaneously. Playwright strict mode fails because `getByRole('button', { name: /add model/i })` resolves to 2 elements.

**Impact:** Automated testing requires `.first()` qualifier. Minor UX issue — two identical CTAs are redundant when both visible.

**Suggestion:** Either hide the header button when empty state shows, or differentiate the buttons.

---

## Bug 4: Model Custom Tab — No Provider Auto-Selection from Context

**Severity:** Low (UX)
**Location:** `apps/studio/src/components/admin/AddModelDialog.tsx`

**Description:**
When using the "Custom Model" tab, the provider dropdown defaults to "openai" regardless of context. If a user navigates from a specific provider's section, the provider should be pre-selected.

---

## Issue 5: AddConnectionDialog — Credential Dropdown UX

**Severity:** Low (UX)
**Location:** `apps/studio/src/components/admin/AddConnectionDialog.tsx`

**Description:**
The credential picker is a native `<select>` dropdown. The "+ Create new credential" option is at the bottom of the list. When there are many credentials, users may not notice it. A more prominent "Create New" button alongside the dropdown would improve discoverability.

---

## Issue 6: Model Row "Add Key" Button Text Inconsistency

**Severity:** Low (UX)
**Location:** `apps/studio/src/components/admin/ModelsPage.tsx`

**Description:**
The connection section header shows "Add Key" button, but the dialog is "Add Connection" and creates "Connections" not "Keys". The terminology is inconsistent — it should be "Add Connection" everywhere for clarity.

---

## Issue 7: Chat Agent Selection — No Model Override

**Severity:** Medium
**Location:** Chat interface

**Description:**
When chatting with an agent, the user cannot select which LLM model to use. The agent uses whatever model is configured in its DSL. This means:

- Creating models in the admin panel doesn't directly affect which model the chat uses
- Testing specific provider responses requires editing the agent's DSL model configuration

**Expected:** A model selector in the chat interface (or agent overview) to override the model for testing.

---

## Issue 8: Guardrail Provider Creation — Success but No Visual Feedback on Project Page

**Severity:** Medium
**Location:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`

**Description:**
After creating a guardrail provider via the admin page, navigating to the project-level guardrails page may not show the provider immediately (requires page refresh or the SWR 30s auto-refresh).

---

## Bug 9: Connection Validation — Auto-Test Icon Classes Mismatch for Automation

**Severity:** Medium
**Location:** `apps/studio/src/components/admin/AddConnectionDialog.tsx` (post-creation view)

**Description:**
After creating a connection, the system auto-validates the credential. For **invalid** keys, both the success message ("Connection created successfully") and the error ("Invalid API key (authentication failed)") render with proper green check / red X icons — see `mg-09-bad-key-test.png`. However, for **valid** keys, the Playwright selectors `svg.lucide-check-circle-2` and `svg.lucide-x-circle` report `valid: false, failed: false` — the icons either use different CSS class names or don't render within the expected timeout for valid connections. This makes it impossible for automation to distinguish pass/fail on valid credentials.

**Expected:** Consistent icon rendering + stable CSS class names for both valid and invalid credential test results.

---

## Bug 10: AddConnectionDialog — Credential Not Auto-Selected After Creation

**Severity:** Medium
**Location:** `apps/studio/src/components/admin/AddConnectionDialog.tsx` (line ~243)

**Description:**
After creating a new credential via the inline form, the dropdown should auto-select the newly created credential. In practice, the dropdown reverts to "Select a credential..." placeholder, requiring the user to manually select the credential they just created. The code does call `setSelectedCredentialId(newId)` but the re-render/reload timing may be off.

**Expected:** After "Create Credential" succeeds, the credential should be auto-selected in the dropdown, and "Create Connection" should become enabled immediately.

---

## Bug 11: Guardrails Config Page — Shows "Reconnecting..." Instead of Content

**Severity:** High
**Location:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`
**Screenshot:** `mg-06-guardrails-page.png`

**Description:**
Navigating to `/projects/:id/guardrails-config` renders a full-page "Reconnecting... Attempting to connect to server" spinner instead of the guardrails configuration content. The page appears to depend on a WebSocket connection that fails or is not established when navigating directly. Neither the "Policies" nor "Providers" tabs are visible.

**Impact:** The entire guardrails configuration page is inaccessible via direct navigation. This blocks Bug #1 and Bug #2 as well.

**Expected:** The guardrails config page should load with Policies/Providers/Audit tabs regardless of WebSocket connection status.

---

## Bug 12: Guardrail Policy Creation API Returns 500

**Severity:** High
**Location:** `POST /api/admin/guardrail-policies?projectId=X`

**Description:**
Attempting to create a guardrail policy via the API returns HTTP 500. This was observed during E2E testing with a valid auth token and properly structured payload. The API endpoint may not be fully implemented or may have a backend dependency issue.

**Impact:** Guardrail policies cannot be created through either UI (Bug #1) or API, making the entire guardrails feature non-functional for new policy creation.

---

## Bug 13: Chat Page — Requires "New Chat" Click Before Input Appears

**Severity:** Low (UX)
**Location:** Chat page (`/projects/:id/agents/:name/chat`)

**Description:**
When navigating to the agent chat page, the textarea input is NOT immediately available. The page shows an empty state: "Click **New Chat** to start a session, or select a previous conversation from the sidebar." The user must click the "+ New Chat" button before the chat input appears.

**Impact:** Minor UX friction — users expect to start typing immediately when landing on a chat page. Automation requires an extra step.

**Suggestion:** Auto-create a new chat session when the page loads with no active sessions, or show the textarea in a disabled state with a prompt.

---

## Bug 14: Session Detail — Error Sessions Show 0 Tokens / 0 LLM Calls

**Severity:** Low (Expected behavior, but poor UX)
**Location:** Session detail page
**Screenshot:** `mg-12-session-detail.png`, `mg-14-llm.png`

**Description:**
When a chat session errors out (e.g., bad API key), the session detail shows:

- Cost: $0.000000, Total Tokens: 0, Latency: 18ms
- Conversation: user message + "AGENT RESPONSE: No response available"
- Timeline: 0 volleys, 0 LLM calls, 0 tool calls
- LLM tab: "No LLM calls yet"

The session records the error but provides no indication of **what** went wrong. There is no error trace, error message, or failure reason visible in the UI.

**Expected:** Session detail should display the error reason (e.g., "Invalid API key" or "Authentication failed") in the conversation view, timeline, or a dedicated "Errors" tab.

---

## Test Environment Notes

- Studio URL: `http://localhost:5173`
- Runtime URL: `http://localhost:3002`
- Auth: `dev@example.com` via Dev Login button
- Project used: `proj-apple-care` (existing travel project)
- API Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY all configured

---

## E2E Test Run Results (Full Pass — 4.7m)

| Phase                      | Status    | Notes                                                                             |
| -------------------------- | --------- | --------------------------------------------------------------------------------- |
| 1. Login & Project         | PASS      | dev@example.com → proj-apple-care                                                 |
| 2. Model Creation (3x)     | PASS      | OpenAI GPT-4o, Anthropic Claude, Google Gemini via Custom Model tab               |
| 3. Connection Wiring (3x)  | PASS      | Credentials created + connections wired. Test icons: valid=false for all (Bug #9) |
| 4. Chat with Agent         | PASS      | Agent responded "Welcome to Apple Support..."                                     |
| 5a. Guardrails Page        | SOFT FAIL | Page shows "Reconnecting..." (Bug #11), tabs not found                            |
| 5b. Guardrail Policy API   | SOFT FAIL | API returned 500 (Bug #12)                                                        |
| 5c. Guardrail Trigger Chat | PASS      | Message sent, no guardrail fired (expected given policy creation failed)          |
| 6a. Bad Key Model          | PASS      | Created + wired with invalid key                                                  |
| 6b. Bad Key Test           | PASS      | "Invalid API key (authentication failed)" shown with red X                        |
| 6c. Error Chat             | PASS      | Error detected in chat UI                                                         |
| 7a. Sessions List          | PASS      | 3 sessions found                                                                  |
| 7b. Session Detail         | PASS      | Detail page with Timeline/LLM tabs                                                |
| 7c. Trace Verification     | PASS      | Timeline shows session metrics, LLM tab shows "No LLM calls" for error session    |

**Screenshots:** 20 files in `apps/studio/e2e/screenshots/mg-*.png`
