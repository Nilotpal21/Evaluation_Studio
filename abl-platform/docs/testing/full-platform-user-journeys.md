# ABL Platform — Complete User Journey Test Scenarios

**Feature**: Full platform user journey coverage — all pages, features, and workflows
**Owner**: QA / Platform Team
**Branch**: Workflow_Tool
**First tested**: 2026-04-16
**Last updated**: 2026-04-16
**Overall status**: NOT STARTED

---

## Current State (as of 2026-04-16)

This document catalogs every testable user journey in the ABL Studio platform, derived from a thorough codebase exploration. It covers 19 major feature areas with positive, negative, and edge case scenarios. No tests have been executed yet — this is the master test plan.

---

## Table of Contents

1. [Authentication & Login](#1-authentication--login)
2. [Onboarding & Workspace Setup](#2-onboarding--workspace-setup)
3. [Project Management](#3-project-management)
4. [Agent Management](#4-agent-management)
5. [Tool Management](#5-tool-management)
6. [Workflow Management](#6-workflow-management)
7. [Knowledge Base / Search AI](#7-knowledge-base--search-ai)
8. [Connections & Integrations](#8-connections--integrations)
9. [Deployments & Channels](#9-deployments--channels)
10. [Sessions & Chat](#10-sessions--chat)
11. [Evaluations (Evals)](#11-evaluations-evals)
12. [MCP Servers](#12-mcp-servers)
13. [Modules](#13-modules)
14. [Human-in-the-Loop / Inbox](#14-human-in-the-loop--inbox)
15. [Admin / Workspace Settings](#15-admin--workspace-settings)
16. [Project Settings](#16-project-settings)
17. [Analytics & Insights](#17-analytics--insights)
18. [Arch AI Assistant](#18-arch-ai-assistant)
19. [Voice & Softphone](#19-voice--softphone)
20. [Cross-Cutting Concerns](#20-cross-cutting-concerns)

---

## 1. Authentication & Login

### 1.1 Dev Login (Development Bypass)

| #     | Scenario                            | Type     | Steps                                                                                                               | Expected Result                                                               |
| ----- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1.1.1 | Dev login with valid credentials    | Positive | Navigate to `/auth/login` → Click "Dev Login" button → Enter email `test@example.com` and name `Test User` → Submit | Redirect to projects dashboard (`/`), JWT issued with correct tenantId/userId |
| 1.1.2 | Dev login populates auth cookies    | Positive | Perform dev login → Inspect cookies                                                                                 | `accessToken` and `refreshToken` cookies are set with correct expiry          |
| 1.1.3 | Dev login with empty email          | Negative | Submit dev login form with blank email                                                                              | 400 error, "Email is required"                                                |
| 1.1.4 | Dev login with invalid email format | Negative | Submit dev login with email `not-an-email`                                                                          | 400 error, validation message                                                 |
| 1.1.5 | Dev login rate limiting             | Edge     | Submit dev login 11 times within 15 minutes                                                                         | 429 "Too many login attempts" after 10th attempt                              |
| 1.1.6 | Dev login disabled in production    | Edge     | Set `NODE_ENV=production` and attempt dev login                                                                     | 404 or feature not available                                                  |

### 1.2 Email/Password Login

| #     | Scenario                             | Type     | Steps                                                               | Expected Result                                                       |
| ----- | ------------------------------------ | -------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1.2.1 | Login with valid email and password  | Positive | Enter registered email → Click "Continue" → Enter password → Submit | Redirect to `/`, tokens set                                           |
| 1.2.2 | Two-step login: email resolution     | Positive | Enter email → Click "Continue"                                      | Resolves to password form (existing user) or signup prompt (new user) |
| 1.2.3 | Login with incorrect password        | Negative | Enter valid email → Enter wrong password → Submit                   | "Invalid credentials" error, no redirect                              |
| 1.2.4 | Login with unregistered email        | Negative | Enter email that doesn't exist → Continue                           | Redirected to signup or "Account not found" message                   |
| 1.2.5 | Login with unverified email          | Edge     | Register but don't verify → Attempt login                           | Redirect to `/auth/verify-email` with "Please verify your email"      |
| 1.2.6 | Login with MFA enabled               | Edge     | Login with MFA-enabled account → Enter password                     | Redirected to MFA challenge screen                                    |
| 1.2.7 | Account locked after failed attempts | Edge     | Enter wrong password 5+ times                                       | Account locked, "Too many failed attempts"                            |
| 1.2.8 | Login preserves redirect URL         | Edge     | Navigate to `/projects/abc/agents` (unauthenticated) → Login        | After login, redirected to `/projects/abc/agents` not `/`             |

### 1.3 OAuth Login (Google, Microsoft, LinkedIn)

| #     | Scenario                           | Type     | Steps                                                  | Expected Result                            |
| ----- | ---------------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------ |
| 1.3.1 | Google OAuth login (existing user) | Positive | Click "Continue with Google" → Authorize → Return      | Logged in, redirect to `/`                 |
| 1.3.2 | Google OAuth login (new user)      | Positive | Click "Continue with Google" → Authorize (new account) | Account created, redirect to onboarding    |
| 1.3.3 | Microsoft OAuth login              | Positive | Click "Continue with Microsoft" → Authorize            | Logged in                                  |
| 1.3.4 | LinkedIn OAuth login               | Positive | Click "Continue with LinkedIn" → Authorize             | Logged in                                  |
| 1.3.5 | OAuth callback with invalid state  | Negative | Tamper with OAuth state parameter                      | Error page: "Invalid authentication state" |
| 1.3.6 | OAuth callback with expired code   | Negative | Delay OAuth callback beyond code expiry                | Error page: "Authentication expired"       |
| 1.3.7 | OAuth provider denies access       | Negative | Deny permission in OAuth provider                      | Redirect to `/auth/error` with message     |

### 1.4 Signup

| #     | Scenario                              | Type     | Steps                                                    | Expected Result                                                      |
| ----- | ------------------------------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| 1.4.1 | Register with valid details           | Positive | Fill name, email, password → Submit                      | Account created, redirect to verify-email                            |
| 1.4.2 | Password strength validation          | Positive | Enter weak password → Observe strength meter             | Strength indicator shows weak/strong appropriately                   |
| 1.4.3 | Register with existing email          | Negative | Submit with already-registered email                     | "Email already registered" error                                     |
| 1.4.4 | Register with weak password           | Negative | Submit with password `123`                               | "Password too weak" validation error                                 |
| 1.4.5 | Register with missing required fields | Negative | Submit with empty name or email                          | Field-level validation errors shown                                  |
| 1.4.6 | Signup via invitation token           | Edge     | Click invite link → Land on signup with pre-filled email | Email pre-populated and read-only, auto-joins workspace after signup |

### 1.5 Token Management

| #     | Scenario                     | Type     | Steps                                              | Expected Result                                                   |
| ----- | ---------------------------- | -------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 1.5.1 | Access token refresh         | Positive | Wait for access token to expire → Make API call    | Auto-refresh via refresh token, seamless UX                       |
| 1.5.2 | Refresh token expired        | Negative | Wait for refresh token to expire → Attempt refresh | Redirect to login page                                            |
| 1.5.3 | Concurrent tab token refresh | Edge     | Open 3 tabs → Let token expire simultaneously      | Only one refresh call, all tabs get new token (no race condition) |
| 1.5.4 | Logout clears all tokens     | Positive | Click user menu → Logout                           | All cookies cleared, redirect to login                            |

### 1.6 MFA (Multi-Factor Authentication)

| #     | Scenario                    | Type     | Steps                                                         | Expected Result                           |
| ----- | --------------------------- | -------- | ------------------------------------------------------------- | ----------------------------------------- |
| 1.6.1 | Setup MFA with TOTP         | Positive | Settings → MFA → Enable → Scan QR → Enter code → Confirm      | MFA enabled, recovery codes shown         |
| 1.6.2 | Login with MFA code         | Positive | Login → Enter valid TOTP code                                 | Authenticated                             |
| 1.6.3 | Login with invalid MFA code | Negative | Login → Enter wrong TOTP code                                 | "Invalid code" error, retry allowed       |
| 1.6.4 | Login with recovery code    | Edge     | Login → Click "Use recovery code" → Enter valid recovery code | Authenticated, recovery code consumed     |
| 1.6.5 | Regenerate recovery codes   | Edge     | Settings → MFA → Regenerate recovery codes                    | New codes generated, old ones invalidated |
| 1.6.6 | Disable MFA                 | Positive | Settings → MFA → Disable → Confirm with code                  | MFA removed                               |

---

## 2. Onboarding & Workspace Setup

| #   | Scenario                          | Type     | Steps                                                                         | Expected Result                                     |
| --- | --------------------------------- | -------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| 2.1 | First-time user creates workspace | Positive | Signup → Verify email → Land on `/onboarding` → Enter workspace name → Create | Workspace created, redirect to projects dashboard   |
| 2.2 | Workspace name validation         | Negative | Enter empty workspace name → Submit                                           | "Workspace name is required"                        |
| 2.3 | Workspace name with special chars | Edge     | Enter workspace name with unicode/emoji                                       | Sanitized or accepted, slug generated properly      |
| 2.4 | Invited user skips onboarding     | Positive | Accept invite → Login                                                         | Joins existing workspace, no onboarding shown       |
| 2.5 | User with multiple invitations    | Edge     | User has 3 pending invites → Login                                            | `/invitations/choose` page shown with all 3 options |
| 2.6 | Accept invitation via token link  | Positive | Click `/invite/[token]` link → Login                                          | Automatically added to workspace                    |
| 2.7 | Expired invitation token          | Negative | Click invite link after expiry                                                | Error: "Invitation has expired"                     |
| 2.8 | Already-used invitation token     | Negative | Click same invite link twice                                                  | Error: "Invitation already used"                    |

---

## 3. Project Management

### 3.1 Project CRUD

| #      | Scenario                           | Type          | Steps                                                                     | Expected Result                                                     |
| ------ | ---------------------------------- | ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 3.1.1  | Create a new project               | Positive      | Dashboard → "New Project" → Enter name, description → Create              | Project created, navigated to project overview                      |
| 3.1.2  | Create project from Arch AI        | Positive      | Dashboard → "Create with Arch AI" → Go through interview → Build → Create | Project created from AI-generated specs                             |
| 3.1.3  | Create project from template       | Positive      | Dashboard → "From Template" → Select template → Customize → Create        | Project created with template resources pre-populated               |
| 3.1.4  | Create project with duplicate name | Negative      | Create project with name that already exists                              | Error or unique suffix appended                                     |
| 3.1.5  | Create project with empty name     | Negative      | Submit project creation with no name                                      | Validation error                                                    |
| 3.1.6  | View project list                  | Positive      | Navigate to dashboard                                                     | All user's projects shown as cards with status indicators           |
| 3.1.7  | Pin/unpin a project                | Positive      | Click pin icon on project card                                            | Project moves to pinned row at top                                  |
| 3.1.8  | Archive a project                  | Positive      | Project menu → Archive → Confirm                                          | Project moves to archived state, removed from active list           |
| 3.1.9  | Restore an archived project        | Positive      | View archived → Click "Restore" on project                                | Project restored to active list                                     |
| 3.1.10 | Delete a project                   | Negative/Edge | Project menu → Delete → Type project name to confirm                      | Project permanently removed, all resources cascade-deleted          |
| 3.1.11 | Project overview page loads        | Positive      | Click into a project                                                      | Overview page shows agent topology, recent sessions, health metrics |

### 3.2 Project Import/Export

| #     | Scenario                        | Type     | Steps                                             | Expected Result                                            |
| ----- | ------------------------------- | -------- | ------------------------------------------------- | ---------------------------------------------------------- |
| 3.2.1 | Export project as bundle        | Positive | Project menu → Export → Select options → Download | ZIP file containing agents, tools, workflows, configs      |
| 3.2.2 | Import project from bundle      | Positive | Dashboard → Import → Upload ZIP → Preview → Apply | Project created with all imported resources                |
| 3.2.3 | Import with conflict resolution | Edge     | Import into existing project with name conflicts  | Preview shows conflicts, user chooses merge/overwrite/skip |
| 3.2.4 | Import invalid/corrupt bundle   | Negative | Upload non-ZIP or corrupt file                    | Error: "Invalid project bundle"                            |
| 3.2.5 | Import revert                   | Edge     | Import → Apply → Click "Revert"                   | Changes undone, project restored to pre-import state       |

---

## 4. Agent Management

### 4.1 Agent CRUD

| #     | Scenario                                     | Type     | Steps                                                                        | Expected Result                                                |
| ----- | -------------------------------------------- | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 4.1.1 | Create reasoning-mode agent                  | Positive | Agents page → "Create Agent" → Name: "Support Bot", Mode: Reasoning → Create | Agent created with skeleton ABL, listed in agent grid          |
| 4.1.2 | Create flow-mode agent                       | Positive | Create Agent → Name: "Order Flow", Mode: Flow → Create                       | Flow agent created with flow step template                     |
| 4.1.3 | Create agent with duplicate name             | Negative | Create agent with name that already exists in project                        | Error: "Agent name already exists"                             |
| 4.1.4 | Create agent with empty name                 | Negative | Submit create dialog with no name                                            | Validation error                                               |
| 4.1.5 | Create agent with special characters in name | Edge     | Name: "my-agent_v2.1"                                                        | Accepted or sanitized; valid ABL identifier generated          |
| 4.1.6 | View agent list (card view)                  | Positive | Navigate to Agents page                                                      | All project agents shown as cards with name, description, mode |
| 4.1.7 | View agent list (canvas/topology view)       | Positive | Click topology toggle on agents page                                         | Agents shown as nodes with handoff/delegate edges              |
| 4.1.8 | Delete an agent                              | Positive | Agent card → Delete → Confirm                                                | Agent removed, references cleaned up                           |
| 4.1.9 | Delete agent with references                 | Edge     | Delete agent that is a delegate/handoff target of another agent              | Warning shown about broken references                          |

### 4.2 Agent Editor

| #      | Scenario                                  | Type     | Steps                                                                        | Expected Result                                         |
| ------ | ----------------------------------------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| 4.2.1  | Edit agent identity (name, persona, goal) | Positive | Open agent → Edit identity section → Save                                    | Identity fields updated, ABL reflects changes           |
| 4.2.2  | Edit agent behavior instructions          | Positive | Open agent → Edit behavior → Add instructions → Save                         | Behavior section updated in ABL                         |
| 4.2.3  | Configure agent tools                     | Positive | Open agent → Tools section → Add tools from picker → Save                    | Tools linked in ABL, available during execution         |
| 4.2.4  | Configure agent handoffs                  | Positive | Open agent → Handoffs → Add handoff to another agent → Set conditions → Save | Handoff defined in ABL with conditions                  |
| 4.2.5  | Configure agent delegates                 | Positive | Open agent → Delegates → Add delegate agent → Save                           | Delegate relationship established                       |
| 4.2.6  | Configure guardrails                      | Positive | Open agent → Guardrails → Select guardrail policies → Save                   | Guardrails attached to agent                            |
| 4.2.7  | Configure gather fields                   | Positive | Open agent → Gather → Add fields (name, type, required) → Save               | Gather section populated in ABL                         |
| 4.2.8  | Configure memory settings                 | Positive | Open agent → Memory → Enable/configure → Save                                | Memory settings applied                                 |
| 4.2.9  | Configure escalation targets              | Positive | Open agent → Escalation → Add targets → Save                                 | Escalation paths defined                                |
| 4.2.10 | Edit ABL DSL directly                     | Positive | Open agent → DSL tab → Edit raw ABL code → Save                              | Changes reflected in visual editor                      |
| 4.2.11 | ABL compilation succeeds                  | Positive | Edit agent → Compile                                                         | "Compilation successful" message, no errors             |
| 4.2.12 | ABL compilation with syntax errors        | Negative | Edit ABL with invalid syntax → Compile                                       | Diagnostics panel shows syntax errors with line numbers |
| 4.2.13 | ABL compilation with semantic errors      | Negative | Reference non-existent tool in ABL → Compile                                 | Warning about unresolved tool reference                 |
| 4.2.14 | Agent editor in modal mode                | Positive | Click agent card → Edit (opens modal)                                        | Full editor in modal overlay                            |
| 4.2.15 | Agent editor in slider mode               | Positive | Click agent from list → Opens as slide-over                                  | Editor in slide panel from right                        |
| 4.2.16 | Agent editor in page mode                 | Positive | Click agent name → Full page                                                 | Full-page editor experience                             |
| 4.2.17 | Flow editor step management               | Positive | Open flow agent → Add/reorder/remove flow steps                              | Steps reflected in flow mini-graph                      |
| 4.2.18 | Agent editor auto-save                    | Edge     | Edit agent fields → Wait → Navigate away → Return                            | Changes auto-saved (or unsaved warning)                 |
| 4.2.19 | Concurrent editing conflict               | Edge     | Two users edit same agent simultaneously                                     | Last-write-wins or conflict notification                |

### 4.3 Agent Versioning

| #     | Scenario                    | Type     | Steps                                            | Expected Result                            |
| ----- | --------------------------- | -------- | ------------------------------------------------ | ------------------------------------------ |
| 4.3.1 | Create agent version        | Positive | Agent detail → Versions → Create version         | New version snapshot created               |
| 4.3.2 | View version history        | Positive | Agent detail → Versions slide-over               | List of versions with timestamps           |
| 4.3.3 | Promote version to active   | Positive | Select version → Promote                         | Version becomes active deployment          |
| 4.3.4 | View version diff           | Positive | Select two versions → Compare                    | Diff view showing changes between versions |
| 4.3.5 | Stale tool reference banner | Edge     | Delete a tool that agent references → Open agent | "Stale tool reference" banner shown        |

### 4.4 Agent Testing (Chat)

| #      | Scenario                            | Type     | Steps                                        | Expected Result                                            |
| ------ | ----------------------------------- | -------- | -------------------------------------------- | ---------------------------------------------------------- |
| 4.4.1  | Chat with agent (basic message)     | Positive | Agent → Chat tab → Type "Hello" → Send       | Agent responds, message appears in chat                    |
| 4.4.2  | Chat with debug panel               | Positive | Toggle debug mode → Send message             | Split pane shows chat + execution trace (spans, LLM calls) |
| 4.4.3  | Chat with tool execution            | Positive | Send message that triggers tool use          | Tool call shown in debug, result incorporated in response  |
| 4.4.4  | Chat with gather data collection    | Positive | Interact with gather-enabled agent           | Agent asks for required fields, collects data sequentially |
| 4.4.5  | Chat with handoff                   | Positive | Trigger handoff condition                    | Conversation handed off to target agent, context preserved |
| 4.4.6  | Chat session reset                  | Positive | Click "Reset" in chat                        | New session started, conversation cleared                  |
| 4.4.7  | Chat with test context              | Positive | Set test context (caller data, mocks) → Chat | Agent uses provided test context                           |
| 4.4.8  | WebSocket disconnection during chat | Edge     | Simulate network drop during conversation    | Reconnection attempt, message not lost                     |
| 4.4.9  | Send empty message                  | Negative | Click send with no text                      | Button disabled or nothing happens                         |
| 4.4.10 | Very long message (10K+ chars)      | Edge     | Paste extremely long text → Send             | Handled gracefully (truncation or accept with warning)     |

---

## 5. Tool Management

### 5.1 Tool CRUD

| #      | Scenario                                  | Type     | Steps                                                               | Expected Result                                                 |
| ------ | ----------------------------------------- | -------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| 5.1.1  | Create HTTP tool                          | Positive | Tools → Create → HTTP → Name, endpoint, method, headers → Save      | HTTP tool created, listed in tools page                         |
| 5.1.2  | Create Sandbox (Code) tool                | Positive | Tools → Create → Code → Name, runtime (Node.js/Python), code → Save | Code tool created                                               |
| 5.1.3  | Create MCP tool                           | Positive | Tools → Create → MCP → Server URL, tool name → Save                 | MCP tool created                                                |
| 5.1.4  | Create Workflow tool                      | Positive | Tools → Create → Workflow → Select workflow, trigger → Save         | Workflow tool created, linked to workflow                       |
| 5.1.5  | Create Lambda tool                        | Positive | Tools → Create → Lambda → ARN, region → Save                        | Lambda tool created                                             |
| 5.1.6  | Create tool with duplicate name           | Negative | Create tool with name that already exists                           | Error: "A tool named X already exists"                          |
| 5.1.7  | Create tool with empty required fields    | Negative | Submit create dialog with missing name/endpoint                     | Validation errors on required fields                            |
| 5.1.8  | Import tool from cURL                     | Positive | Tools → Import cURL → Paste curl command → Import                   | Tool auto-populated from cURL (endpoint, method, headers, body) |
| 5.1.9  | Import tool from cURL with invalid syntax | Negative | Paste malformed cURL command                                        | Error: "Could not parse cURL command"                           |
| 5.1.10 | Duplicate a tool                          | Positive | Tool menu → Duplicate                                               | Clone created with name "Copy of X"                             |
| 5.1.11 | Delete a tool                             | Positive | Tool menu → Delete → Confirm                                        | Tool removed from list                                          |
| 5.1.12 | Delete tool referenced by agent           | Edge     | Delete tool that is used in an agent ABL                            | Warning about agent references                                  |
| 5.1.13 | Export tool                               | Positive | Tool menu → Export                                                  | Tool definition downloaded as JSON                              |
| 5.1.14 | View tools list with tabs                 | Positive | Navigate to Tools page                                              | Tabs: HTTP, Code, SearchAI, Workflow, MCP filter tools by type  |

### 5.2 Tool Configuration (HTTP)

| #     | Scenario                                     | Type     | Steps                                                             | Expected Result                                  |
| ----- | -------------------------------------------- | -------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| 5.2.1 | Configure GET endpoint                       | Positive | Set method=GET, endpoint URL, query params → Save                 | Correct configuration stored                     |
| 5.2.2 | Configure POST with JSON body                | Positive | Set method=POST, body template with JSON → Save                   | Body template stored                             |
| 5.2.3 | Configure auth headers                       | Positive | Add Authorization header with Bearer token → Save                 | Header stored (value may be encrypted)           |
| 5.2.4 | Configure with secret variable reference     | Positive | Set header value to `{{secrets.API_KEY}}` → Save                  | Variable reference stored, resolves at runtime   |
| 5.2.5 | Configure with SSRF-blocked endpoint         | Negative | Set endpoint to `http://169.254.169.254/` → Save                  | Error: "Endpoint blocked by SSRF protection"     |
| 5.2.6 | Configure with invalid URL                   | Negative | Set endpoint to `not-a-url` → Save                                | Validation error on endpoint field               |
| 5.2.7 | Configure tool parameters (input schema)     | Positive | Add parameters with name, type, description, required flag → Save | Parameters stored, used for LLM function calling |
| 5.2.8 | Configure headers as object instead of array | Negative | Send headers as `{}` instead of `[]`                              | Validation error: "Headers must be an array"     |

### 5.3 Tool Testing

| #     | Scenario                                   | Type     | Steps                                            | Expected Result                              |
| ----- | ------------------------------------------ | -------- | ------------------------------------------------ | -------------------------------------------- |
| 5.3.1 | Test HTTP tool with valid input            | Positive | Tool detail → Test → Fill parameters → Execute   | Response shown with status, headers, body    |
| 5.3.2 | Test tool with missing required parameters | Negative | Test tool without filling required fields        | Validation error before execution            |
| 5.3.3 | Test tool with endpoint timeout            | Edge     | Test tool pointing to slow/unresponsive endpoint | Timeout error with clear message             |
| 5.3.4 | Test tool with 4xx response                | Edge     | Test tool that returns 404                       | Error response shown clearly, not as success |
| 5.3.5 | Test Sandbox tool with code error          | Edge     | Test code tool with runtime exception in code    | Error details shown with stack trace         |
| 5.3.6 | Preview tool output                        | Positive | Tool detail → Preview                            | Shows expected output format                 |

### 5.4 Tool Wizards

| #     | Scenario                      | Type     | Steps                                                                       | Expected Result                         |
| ----- | ----------------------------- | -------- | --------------------------------------------------------------------------- | --------------------------------------- |
| 5.4.1 | HTTP tool wizard (multi-step) | Positive | Create → HTTP Wizard → Step 1: Basic → Step 2: Auth → Step 3: Params → Save | Tool created with all wizard fields     |
| 5.4.2 | Sandbox tool wizard           | Positive | Create → Code Wizard → Select runtime → Write code → Define params → Save   | Code tool created                       |
| 5.4.3 | MCP tool wizard               | Positive | Create → MCP Wizard → Server URL → Discover tools → Select → Save           | MCP tool created with discovered schema |
| 5.4.4 | Wizard back navigation        | Edge     | Progress through wizard → Click Back on step 3                              | Returns to step 2 with data preserved   |
| 5.4.5 | Wizard cancel mid-flow        | Edge     | Start wizard → Fill some data → Cancel                                      | No tool created, no orphan data         |

---

## 6. Workflow Management

### 6.1 Workflow CRUD

| #     | Scenario                            | Type     | Steps                                                            | Expected Result                                             |
| ----- | ----------------------------------- | -------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| 6.1.1 | Create a new workflow               | Positive | Workflows → "Create Workflow" → Enter name, description → Create | Workflow created, navigate to canvas                        |
| 6.1.2 | Create workflow with duplicate name | Negative | Create workflow with existing name                               | Error or unique suffix                                      |
| 6.1.3 | Create workflow with empty name     | Negative | Submit with no name                                              | Validation error                                            |
| 6.1.4 | View workflows list                 | Positive | Navigate to Workflows page                                       | Grid of workflow cards with status, last-run info           |
| 6.1.5 | Delete a workflow                   | Positive | Workflow menu → Delete → Confirm                                 | Workflow removed, associated triggers/executions cleaned up |
| 6.1.6 | Delete workflow referenced by tool  | Edge     | Delete workflow that a workflow-tool references                  | Warning about dependent tools                               |

### 6.2 Workflow Canvas Builder

| #      | Scenario                                      | Type     | Steps                                                                                       | Expected Result                                   |
| ------ | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 6.2.1  | Add node from assets sidebar                  | Positive | Drag "Function" node from sidebar → Drop on canvas                                          | Node added to canvas at drop position             |
| 6.2.2  | Add all node types                            | Positive | Add each type: API, Condition, Data Entry, Function, Human, Integration, Loop, Text-to-Text | All node types render correctly on canvas         |
| 6.2.3  | Connect two nodes                             | Positive | Drag from node output handle to another node input                                          | Edge created between nodes                        |
| 6.2.4  | Delete a node                                 | Positive | Select node → Press Delete or click delete button                                           | Node and its edges removed                        |
| 6.2.5  | Delete an edge                                | Positive | Click edge delete button                                                                    | Edge removed, nodes remain                        |
| 6.2.6  | Configure start node                          | Positive | Click start node → Configure input schema                                                   | Start node shows config panel with input fields   |
| 6.2.7  | Configure end node                            | Positive | Click end node → Configure output mapping                                                   | End node config saved                             |
| 6.2.8  | Configure function node                       | Positive | Click function node → Write JavaScript/TypeScript code → Save                               | Code stored, editor overlay works                 |
| 6.2.9  | Configure condition node (branching)          | Positive | Click condition node → Define conditions → Map branches                                     | Branches created, edges split per condition       |
| 6.2.10 | Configure API node                            | Positive | Click API node → Set URL, method, headers, body → Save                                      | HTTP call configuration stored                    |
| 6.2.11 | Configure human task node                     | Positive | Click human node → Define form fields → Set assignee → Save                                 | Human task node configured                        |
| 6.2.12 | Configure data entry node                     | Positive | Click data entry → Define input fields → Save                                               | Data collection step configured                   |
| 6.2.13 | Configure loop node                           | Positive | Click loop → Set collection, iterator, max iterations → Save                                | Loop properly configured                          |
| 6.2.14 | Configure integration node                    | Positive | Click integration → Pick integration → Configure action → Save                              | Integration step configured                       |
| 6.2.15 | Configure text-to-text (LLM) node             | Positive | Click text-to-text → Set prompt template, model → Save                                      | LLM step configured                               |
| 6.2.16 | Quick-add node from handle menu               | Positive | Hover over node handle → Click "+" → Select type                                            | New node added and auto-connected                 |
| 6.2.17 | Canvas zoom in/out                            | Positive | Use scroll wheel or zoom controls                                                           | Canvas zooms smoothly                             |
| 6.2.18 | Canvas pan                                    | Positive | Click and drag on empty canvas area                                                         | Canvas pans                                       |
| 6.2.19 | Canvas undo/redo                              | Positive | Make change → Ctrl+Z → Ctrl+Shift+Z                                                         | Changes undone and redone                         |
| 6.2.20 | Auto-save workflow                            | Positive | Make edits → Wait for auto-save indicator                                                   | "Saved" indicator appears, changes persisted      |
| 6.2.21 | Workflow validation (errors panel)            | Positive | Create disconnected node → Check validation panel                                           | Warning: "Node X is not connected"                |
| 6.2.22 | Workflow validation (missing required config) | Negative | Add API node without URL → Validate                                                         | Error: "API node requires endpoint URL"           |
| 6.2.23 | Canvas with 50+ nodes                         | Edge     | Build complex workflow with many nodes                                                      | Canvas remains responsive, layout algorithm works |
| 6.2.24 | Sidebar auto-collapse on canvas entry         | Edge     | Navigate to workflow canvas                                                                 | Sidebar collapses to give maximum canvas space    |

### 6.3 Workflow Execution

| #     | Scenario                               | Type     | Steps                                                  | Expected Result                                                       |
| ----- | -------------------------------------- | -------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 6.3.1 | Execute workflow manually (Run dialog) | Positive | Click "Run" → Provide input → Execute                  | Execution starts, progress shown in debug panel                       |
| 6.3.2 | View execution trace                   | Positive | After execution → Open debug panel                     | Step-by-step execution trace with timing, input/output                |
| 6.3.3 | Cancel running execution               | Positive | Start long workflow → Click "Cancel"                   | Execution cancelled, status updated                                   |
| 6.3.4 | Execution with failing step            | Edge     | Run workflow with an API node pointing to down service | Failure shown on specific step, execution halts or follows error path |
| 6.3.5 | Execution with human approval step     | Edge     | Run workflow with human node → Task appears in inbox   | Execution pauses, task created in inbox, resumes on approval          |
| 6.3.6 | View execution history                 | Positive | Workflow detail → Executions tab                       | List of past executions with status, duration, timestamp              |
| 6.3.7 | View individual execution detail       | Positive | Click on execution from list                           | Full execution detail with step log, inputs, outputs                  |

### 6.4 Workflow Triggers

| #     | Scenario                             | Type     | Steps                                                           | Expected Result                               |
| ----- | ------------------------------------ | -------- | --------------------------------------------------------------- | --------------------------------------------- |
| 6.4.1 | Create webhook trigger               | Positive | Workflow → Triggers → Add Webhook → Save                        | Webhook URL generated                         |
| 6.4.2 | Create scheduled trigger (cron)      | Positive | Workflow → Triggers → Add Schedule → Set cron expression → Save | Schedule trigger created                      |
| 6.4.3 | Create app trigger                   | Positive | Workflow → Triggers → Add App Trigger → Select event → Save     | App event trigger configured                  |
| 6.4.4 | Generate webhook key                 | Positive | Create webhook trigger → Generate key                           | Unique key created for webhook authentication |
| 6.4.5 | Delete a trigger                     | Positive | Select trigger → Delete → Confirm                               | Trigger removed                               |
| 6.4.6 | Trigger with invalid cron expression | Negative | Enter invalid cron string → Save                                | Validation error: "Invalid cron expression"   |
| 6.4.7 | View trigger code snippets           | Positive | Select webhook trigger → View code                              | cURL/Python/JavaScript snippets shown         |

### 6.5 Workflow Versioning

| #     | Scenario                | Type     | Steps                                     | Expected Result                             |
| ----- | ----------------------- | -------- | ----------------------------------------- | ------------------------------------------- |
| 6.5.1 | Create workflow version | Positive | Workflow → Versions tab → Save as version | New version snapshot created                |
| 6.5.2 | View version list       | Positive | Workflow → Versions tab                   | List of versions with timestamps and status |
| 6.5.3 | Activate a version      | Positive | Select version → Activate                 | Version becomes active, old one deactivated |
| 6.5.4 | Deactivate a version    | Positive | Select active version → Deactivate        | Version deactivated                         |
| 6.5.5 | View version diff       | Positive | Select two versions → Compare             | Side-by-side diff of workflow definitions   |
| 6.5.6 | Soft-delete a version   | Edge     | Delete a non-active version               | Version soft-deleted, recoverable           |

### 6.6 Workflow Notifications

| #     | Scenario                                 | Type     | Steps                                                      | Expected Result                            |
| ----- | ---------------------------------------- | -------- | ---------------------------------------------------------- | ------------------------------------------ |
| 6.6.1 | Create notification rule (on failure)    | Positive | Workflow → Notifications → Add → On failure → Email → Save | Notification rule created                  |
| 6.6.2 | Create notification rule (on completion) | Positive | Add → On completion → Webhook → Save                       | Rule created                               |
| 6.6.3 | Test notification rule                   | Positive | Select rule → Test                                         | Test notification sent, confirmation shown |
| 6.6.4 | Delete notification rule                 | Positive | Select rule → Delete                                       | Rule removed                               |
| 6.6.5 | Update notification rule                 | Positive | Edit existing rule → Change channel → Save                 | Rule updated                               |

---

## 7. Knowledge Base / Search AI

### 7.1 Knowledge Base CRUD

| #     | Scenario                      | Type     | Steps                                                            | Expected Result                                    |
| ----- | ----------------------------- | -------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| 7.1.1 | Create knowledge base         | Positive | Search AI → "Create Knowledge Base" → Name, description → Create | KB created, dashboard shows new entry              |
| 7.1.2 | Create KB with duplicate name | Negative | Create KB with existing name                                     | Error                                              |
| 7.1.3 | Delete knowledge base         | Positive | KB menu → Delete → Confirm                                       | KB and all indexed content removed                 |
| 7.1.4 | View KB dashboard             | Positive | Navigate to Search AI page                                       | Cards showing all KBs with document counts, status |

### 7.2 Content Ingestion

| #      | Scenario                              | Type     | Steps                                                     | Expected Result                                      |
| ------ | ------------------------------------- | -------- | --------------------------------------------------------- | ---------------------------------------------------- |
| 7.2.1  | Upload files to KB                    | Positive | KB detail → Sources → Upload files (PDF, DOCX, TXT)       | Files ingested, documents appear in document table   |
| 7.2.2  | Upload unsupported file type          | Negative | Upload .exe file                                          | Error: "Unsupported file type"                       |
| 7.2.3  | Upload oversized file                 | Negative | Upload file exceeding size limit                          | Error: "File exceeds maximum size"                   |
| 7.2.4  | Add web crawl source                  | Positive | KB → Sources → Add URL → Configure crawl settings → Start | Crawl job started, pages indexed progressively       |
| 7.2.5  | Add enterprise connector (SharePoint) | Positive | KB → Sources → SharePoint → OAuth → Select sites → Save   | SharePoint content synced                            |
| 7.2.6  | View documents table                  | Positive | KB detail → Documents tab                                 | Table of indexed documents with status, chunks, date |
| 7.2.7  | View chunks for a document            | Positive | Click document → Expand chunks                            | Chunked content shown with embeddings status         |
| 7.2.8  | Delete a document                     | Positive | Document menu → Delete                                    | Document and chunks removed from index               |
| 7.2.9  | Delete all crawled pages              | Edge     | Crawl source → Delete all → Confirm                       | All pages from crawl removed                         |
| 7.2.10 | Reindex knowledge base                | Edge     | KB → Reindex → Confirm                                    | Full reindex triggered, progress shown               |

### 7.3 Query & Search

| #     | Scenario                       | Type     | Steps                                               | Expected Result                              |
| ----- | ------------------------------ | -------- | --------------------------------------------------- | -------------------------------------------- |
| 7.3.1 | Query playground: basic search | Positive | KB detail → Query Playground → Enter query → Search | Results returned with relevance scores       |
| 7.3.2 | Query with no results          | Edge     | Search for non-existent topic                       | Empty result with "No results found" message |
| 7.3.3 | Query with filters             | Positive | Add source filter → Search                          | Results filtered to specified source         |
| 7.3.4 | Structured search query        | Positive | Use structured query mode                           | Results match structured criteria            |
| 7.3.5 | Similar document search        | Positive | Select document → "Find similar"                    | Related documents returned                   |

### 7.4 Vocabulary & Attributes

| #     | Scenario                   | Type     | Steps                                                     | Expected Result                              |
| ----- | -------------------------- | -------- | --------------------------------------------------------- | -------------------------------------------- |
| 7.4.1 | Create vocabulary entry    | Positive | KB → Vocabulary → Add → Term, synonyms, definition → Save | Vocabulary entry created                     |
| 7.4.2 | Test vocabulary resolution | Positive | Vocabulary → Test → Enter query with synonym              | Shows how synonym resolves to canonical term |
| 7.4.3 | Bulk import vocabulary     | Positive | Upload CSV of vocabulary entries                          | Entries imported in bulk                     |
| 7.4.4 | Manage attributes          | Positive | KB → Attributes tab → View/edit attribute types           | Attribute table shows all metadata fields    |

### 7.5 Knowledge Graph & Pipelines

| #     | Scenario                           | Type     | Steps                                           | Expected Result                           |
| ----- | ---------------------------------- | -------- | ----------------------------------------------- | ----------------------------------------- |
| 7.5.1 | Enable knowledge graph enrichment  | Positive | KB → KG toggle → Enable                         | KG processing starts on documents         |
| 7.5.2 | View KG entities and relationships | Positive | KB → Knowledge Graph tab                        | Graph visualization of entities           |
| 7.5.3 | Configure embedding model          | Positive | KB → Settings → Embedding model → Select/change | Embedding model updated, reindex prompted |
| 7.5.4 | Edit search pipeline               | Positive | KB → Pipeline → Add/remove/reorder stages       | Pipeline configuration saved              |
| 7.5.5 | Test pipeline selection            | Positive | Pipeline → Test → Enter query → Execute         | Shows pipeline stage results step by step |

---

## 8. Connections & Integrations

| #    | Scenario                            | Type     | Steps                                                    | Expected Result                                              |
| ---- | ----------------------------------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 8.1  | View connections catalog            | Positive | Navigate to Connections page → Catalog tab               | Available connectors listed (Slack, Teams, Salesforce, etc.) |
| 8.2  | Create connection via OAuth         | Positive | Select connector → Click "Connect" → Complete OAuth flow | Connection established, status shows "Connected"             |
| 8.3  | Create connection with API key      | Positive | Select connector → Enter API key → Save                  | Connection created                                           |
| 8.4  | Test connection                     | Positive | Connection card → Test                                   | "Connection successful" or error details                     |
| 8.5  | Edit connection credentials         | Positive | Connection → Edit → Update credentials → Save            | Credentials updated                                          |
| 8.6  | Delete connection                   | Positive | Connection → Delete → Confirm                            | Connection removed                                           |
| 8.7  | Connection with invalid credentials | Negative | Create connection with wrong API key → Test              | Test fails: "Authentication failed"                          |
| 8.8  | OAuth flow cancelled by user        | Edge     | Start OAuth → Cancel in provider window                  | Return to connections page, no connection created            |
| 8.9  | OAuth token refresh failure         | Edge     | Connection with expired OAuth token that can't refresh   | Status shows "Disconnected", re-auth required                |
| 8.10 | Agent Desktop connection setup      | Edge     | Set up Agent Desktop specific connection                 | Dialog guides through Agent Desktop config                   |

---

## 9. Deployments & Channels

### 9.1 Deployment Management

| #     | Scenario                            | Type     | Steps                                                         | Expected Result                                       |
| ----- | ----------------------------------- | -------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| 9.1.1 | Create deployment                   | Positive | Deployments → "New Deployment" → Select environment → Create  | Deployment created with snapshot                      |
| 9.1.2 | Promote deployment                  | Positive | Select deployment → Promote to next environment               | New deployment created in target env, config migrated |
| 9.1.3 | View deployment snapshot diff       | Positive | Compare two deployments                                       | Side-by-side diff of agent config changes             |
| 9.1.4 | Copy variables between environments | Positive | Deployment → Copy Variables → Select source/target env → Copy | Config variables replicated                           |
| 9.1.5 | Get embed code                      | Positive | Deployment → Embed Code                                       | HTML/JS snippet for embedding widget                  |

### 9.2 Channel Management

| #     | Scenario                     | Type     | Steps                                                            | Expected Result                          |
| ----- | ---------------------------- | -------- | ---------------------------------------------------------------- | ---------------------------------------- |
| 9.2.1 | Create Web channel           | Positive | Deployment → Channels → Add Web Channel → Configure theme → Save | Web widget channel created               |
| 9.2.2 | Create Voice channel (S2S)   | Positive | Add Voice Channel → Configure provider (Twilio) → Save           | Voice channel created                    |
| 9.2.3 | Create channel instance      | Positive | Channel → New Instance → Configure → Save                        | Instance created with unique connection  |
| 9.2.4 | Update channel configuration | Positive | Edit channel → Change theme/settings → Save                      | Configuration updated                    |
| 9.2.5 | Delete channel               | Positive | Channel → Delete → Confirm                                       | Channel and instances removed            |
| 9.2.6 | View channel activity        | Positive | Channel → Activity tab                                           | Recent session activity for this channel |

### 9.3 API Keys & SDK

| #     | Scenario                        | Type     | Steps                                | Expected Result                   |
| ----- | ------------------------------- | -------- | ------------------------------------ | --------------------------------- |
| 9.3.1 | Generate API key for deployment | Positive | Deployment → API Keys → Generate     | New API key created, shown once   |
| 9.3.2 | Revoke API key                  | Positive | Select key → Revoke → Confirm        | Key invalidated immediately       |
| 9.3.3 | Generate share link             | Positive | Deployment → Share → Generate link   | Public preview URL generated      |
| 9.3.4 | Generate preview token          | Positive | Deployment → Preview Token           | Token generated for testing       |
| 9.3.5 | Access preview via share link   | Positive | Open share link in incognito browser | Chat widget loads, agent responds |

---

## 10. Sessions & Chat

### 10.1 Session Management

| #      | Scenario                      | Type     | Steps                          | Expected Result                                      |
| ------ | ----------------------------- | -------- | ------------------------------ | ---------------------------------------------------- |
| 10.1.1 | View sessions list            | Positive | Navigate to Sessions page      | List of all project sessions with metrics            |
| 10.1.2 | Filter sessions by status     | Positive | Apply "Active" filter          | Only active sessions shown                           |
| 10.1.3 | Filter sessions by agent      | Positive | Select specific agent filter   | Sessions for that agent only                         |
| 10.1.4 | Filter sessions by date range | Positive | Set custom date range          | Sessions within range shown                          |
| 10.1.5 | View session detail           | Positive | Click on session               | Full session view: messages, metrics, execution tree |
| 10.1.6 | View session metrics bar      | Positive | Open session detail            | Duration, message count, token usage, cost displayed |
| 10.1.7 | View agent execution tree     | Positive | Session detail → Execution tab | Tree of agent interactions with handoffs             |
| 10.1.8 | View voice session metrics    | Positive | Open voice session             | Voice-specific metrics: latency, quality, duration   |
| 10.1.9 | Empty sessions list           | Edge     | New project with no sessions   | Empty state with guidance                            |

### 10.2 Chat Preview

| #      | Scenario                             | Type     | Steps                                                | Expected Result                                |
| ------ | ------------------------------------ | -------- | ---------------------------------------------------- | ---------------------------------------------- |
| 10.2.1 | Preview chat loads correctly         | Positive | Navigate to `/preview` with valid share token        | Chat widget loads with agent branding          |
| 10.2.2 | Send and receive messages in preview | Positive | Type message → Send → Wait for response              | Agent responds via WebSocket                   |
| 10.2.3 | Preview with auth challenge          | Edge     | Agent requires JIT auth → Preview triggers challenge | Auth challenge card shown, user completes auth |
| 10.2.4 | Preview with attachments             | Positive | Upload file in preview chat                          | File attached, agent processes content         |
| 10.2.5 | Preview with invalid/expired token   | Negative | Navigate to preview with expired share token         | "Link expired" or "Invalid link" error         |
| 10.2.6 | Voice mode in preview                | Positive | Click voice mode toggle → Speak                      | Real-time voice streaming works                |

---

## 11. Evaluations (Evals)

### 11.1 Personas

| #      | Scenario                       | Type     | Steps                                                        | Expected Result                                    |
| ------ | ------------------------------ | -------- | ------------------------------------------------------------ | -------------------------------------------------- |
| 11.1.1 | Create test persona            | Positive | Evals → Personas → Create → Name, description, traits → Save | Persona created                                    |
| 11.1.2 | AI-generate personas           | Positive | Personas → Auto-Generate → Configure → Generate              | Multiple personas generated based on agent context |
| 11.1.3 | Create persona with empty name | Negative | Submit with no name                                          | Validation error                                   |

### 11.2 Scenarios

| #      | Scenario                              | Type     | Steps                                                              | Expected Result                                 |
| ------ | ------------------------------------- | -------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| 11.2.1 | Create test scenario                  | Positive | Evals → Scenarios → Create → Description, expected behavior → Save | Scenario created                                |
| 11.2.2 | AI-generate scenarios                 | Positive | Scenarios → Auto-Generate                                          | Scenarios generated based on agent capabilities |
| 11.2.3 | Create scenario with expected outcome | Positive | Define scenario with specific expected output criteria             | Criteria stored for automated evaluation        |

### 11.3 Evaluators

| #      | Scenario                       | Type     | Steps                                                          | Expected Result                 |
| ------ | ------------------------------ | -------- | -------------------------------------------------------------- | ------------------------------- |
| 11.3.1 | Create evaluator from template | Positive | Evals → Evaluators → From Template → Select → Customize → Save | Evaluator created from template |
| 11.3.2 | Create custom evaluator        | Positive | Evals → Evaluators → Custom → Define rubric → Save             | Custom evaluator with rubric    |
| 11.3.3 | Configure rubric criteria      | Positive | Evaluator → Rubric Builder → Add criteria with scores → Save   | Rubric defined                  |
| 11.3.4 | Configure bias settings        | Edge     | Evaluator → Bias → Configure position/order bias settings      | Bias detection configured       |

### 11.4 Eval Sets & Runs

| #      | Scenario                      | Type     | Steps                                                                 | Expected Result                                  |
| ------ | ----------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 11.4.1 | Create evaluation set         | Positive | Evals → Sets → Create → Select personas, scenarios, evaluators → Save | Eval set created                                 |
| 11.4.2 | Start evaluation run          | Positive | Eval set → Start Run → Configure → Execute                            | Run starts, progress shown                       |
| 11.4.3 | View run results heatmap      | Positive | Completed run → Heatmap tab                                           | Color-coded heatmap of persona × scenario scores |
| 11.4.4 | Compare two runs              | Positive | Select two runs → Compare                                             | Side-by-side comparison with score differences   |
| 11.4.5 | Cancel running evaluation     | Positive | Active run → Cancel                                                   | Run cancelled, partial results preserved         |
| 11.4.6 | Quick eval                    | Positive | Quick Eval button → Send prompt → Get score                           | Instant single-prompt evaluation                 |
| 11.4.7 | Preflight validation          | Edge     | Start run with misconfigured agent                                    | Preflight check catches issues before run starts |
| 11.4.8 | View score trends across runs | Positive | Runs list → Trend view                                                | Chart showing score progression across runs      |
| 11.4.9 | Cost estimate before run      | Positive | Configure run → View cost estimate                                    | Estimated token/cost shown before execution      |

---

## 12. MCP Servers

| #    | Scenario                            | Type     | Steps                                                           | Expected Result                              |
| ---- | ----------------------------------- | -------- | --------------------------------------------------------------- | -------------------------------------------- |
| 12.1 | Register MCP server                 | Positive | Tools → MCP tab → "Add Server" → URL, transport, headers → Save | Server registered                            |
| 12.2 | Test MCP server connection          | Positive | Server → Test Connection                                        | "Connected" or error details                 |
| 12.3 | Discover tools from MCP server      | Positive | Server → Discover Tools                                         | List of available tools shown with schemas   |
| 12.4 | Preview discovered tool             | Positive | Discovered tool → Preview                                       | Schema, parameters, description shown        |
| 12.5 | Test specific MCP tool              | Positive | Discovered tool → Test → Fill params → Execute                  | Tool executed, result shown                  |
| 12.6 | Register server with invalid URL    | Negative | Enter non-reachable URL → Save → Test                           | Connection test fails: "Cannot reach server" |
| 12.7 | Server with authentication required | Edge     | Register server needing auth → Provide headers → Test           | Auth headers sent correctly                  |
| 12.8 | Delete MCP server                   | Positive | Server → Delete → Confirm                                       | Server removed, associated tools cleaned up  |
| 12.9 | View MCP server detail page         | Positive | Click on registered server                                      | Detail page with status, tools list, logs    |

---

## 13. Modules

| #    | Scenario                              | Type     | Steps                                                       | Expected Result                                    |
| ---- | ------------------------------------- | -------- | ----------------------------------------------------------- | -------------------------------------------------- |
| 13.1 | Publish project as module             | Positive | Project → Module → Publish → Version, description → Publish | Module published to catalog                        |
| 13.2 | Browse module catalog                 | Positive | Project → Dependencies → Browse Catalog                     | Available modules listed                           |
| 13.3 | Import module dependency              | Positive | Select module → Import → Confirm                            | Module added as dependency, agents/tools available |
| 13.4 | Upgrade module to new version         | Positive | Dependencies → Module → Upgrade → Select version            | Module updated, diff shown                         |
| 13.5 | Remove module dependency              | Positive | Dependencies → Module → Remove                              | Module dependency removed                          |
| 13.6 | View reverse dependencies (consumers) | Positive | Published module → Consumers tab                            | Projects using this module listed                  |
| 13.7 | Import module with version conflict   | Edge     | Import module that conflicts with existing resources        | Conflict preview shown, user decides resolution    |
| 13.8 | Archive module release                | Positive | Module → Releases → Archive old release                     | Release archived, users on it notified             |
| 13.9 | Promote module release                | Positive | Module → Releases → Promote to stable                       | Release marked as recommended                      |

---

## 14. Human-in-the-Loop / Inbox

| #     | Scenario                        | Type     | Steps                                              | Expected Result                                               |
| ----- | ------------------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------- |
| 14.1  | View unified inbox              | Positive | Navigate to Inbox page                             | All pending human tasks listed (workflow + agent escalations) |
| 14.2  | Claim a task                    | Positive | Click "Claim" on unassigned task                   | Task assigned to current user                                 |
| 14.3  | Assign task to team member      | Positive | Task → Assign → Select member → Confirm            | Task reassigned                                               |
| 14.4  | Resolve task with approval      | Positive | Open task → Review data → Click "Approve" → Submit | Task resolved, workflow/agent continues                       |
| 14.5  | Resolve task with rejection     | Positive | Open task → Click "Reject" → Add reason → Submit   | Task rejected, workflow follows rejection path                |
| 14.6  | Submit data entry task          | Positive | Open data entry task → Fill form fields → Submit   | Form data submitted, workflow continues                       |
| 14.7  | View task from workflow context | Positive | Inbox → Click task → View workflow step            | Task detail shows workflow context                            |
| 14.8  | View task from agent escalation | Positive | Inbox → Click escalated task                       | Task detail shows agent conversation context                  |
| 14.9  | Empty inbox                     | Edge     | No pending tasks                                   | Empty state: "No tasks pending"                               |
| 14.10 | Task with expired SLA           | Edge     | View task past its deadline                        | Visual indicator of overdue status                            |
| 14.11 | Inbox segmented views           | Positive | Switch between Workflow / Agent mailbox segments   | Filtered views show relevant tasks only                       |

---

## 15. Admin / Workspace Settings

### 15.1 Members & Roles

| #       | Scenario                  | Type     | Steps                                             | Expected Result                            |
| ------- | ------------------------- | -------- | ------------------------------------------------- | ------------------------------------------ |
| 15.1.1  | View workspace members    | Positive | Admin → Members                                   | List of all workspace members with roles   |
| 15.1.2  | Invite new member         | Positive | Members → Invite → Enter email, role → Send       | Invitation sent                            |
| 15.1.3  | Invite with invalid email | Negative | Invite with `not-an-email`                        | Validation error                           |
| 15.1.4  | Resend invitation         | Positive | Pending invite → Resend                           | Invitation resent                          |
| 15.1.5  | Revoke invitation         | Positive | Pending invite → Revoke                           | Invitation invalidated                     |
| 15.1.6  | Change member role        | Positive | Member → Change role → Select new role → Save     | Role updated                               |
| 15.1.7  | Deactivate member         | Positive | Member → Deactivate                               | Member can no longer access workspace      |
| 15.1.8  | Reactivate member         | Positive | Deactivated member → Reactivate                   | Access restored                            |
| 15.1.9  | Suspend member            | Positive | Member → Suspend                                  | Temporary suspension                       |
| 15.1.10 | Lock/unlock member        | Edge     | Lock member account → Unlock                      | Account locked/unlocked                    |
| 15.1.11 | Revoke all sessions       | Positive | Member → Revoke Sessions                          | All active sessions terminated             |
| 15.1.12 | Create custom role        | Positive | Admin → Roles → Create → Name, permissions → Save | Custom role available for assignment       |
| 15.1.13 | Delete custom role        | Positive | Role → Delete → Confirm                           | Role removed, members with role reassigned |
| 15.1.14 | Demote last owner         | Edge     | Try to change the only Owner to Member            | Error: "Cannot remove the last owner"      |

### 15.2 LLM Providers & Models

| #      | Scenario                          | Type     | Steps                                                       | Expected Result                  |
| ------ | --------------------------------- | -------- | ----------------------------------------------------------- | -------------------------------- |
| 15.2.1 | Add LLM provider (OpenAI)         | Positive | Admin → Models → Add → Select OpenAI → Enter API key → Save | Provider added, models available |
| 15.2.2 | Add LLM provider with invalid key | Negative | Enter incorrect API key → Test                              | "Invalid API key" error          |
| 15.2.3 | Configure model parameters        | Positive | Model → Edit → Set temperature, max tokens → Save           | Parameters stored                |
| 15.2.4 | Remove LLM provider               | Positive | Provider → Remove → Confirm                                 | Provider removed                 |
| 15.2.5 | Validate API key                  | Positive | Provider → Test Connection                                  | "Key valid" or error             |

### 15.3 Security

| #      | Scenario                      | Type     | Steps                                         | Expected Result                   |
| ------ | ----------------------------- | -------- | --------------------------------------------- | --------------------------------- |
| 15.3.1 | View security settings        | Positive | Admin → Security                              | Security configuration page loads |
| 15.3.2 | Configure SSO domain          | Positive | Security → SSO → Add domain → Verify → Enable | SSO enabled for domain            |
| 15.3.3 | Verify SSO domain             | Positive | Add DNS TXT record → Click Verify             | Domain verified                   |
| 15.3.4 | SSO domain verification fails | Negative | Click Verify without DNS record               | "Verification failed"             |

### 15.4 Other Admin Settings

| #       | Scenario                               | Type     | Steps                                              | Expected Result                       |
| ------- | -------------------------------------- | -------- | -------------------------------------------------- | ------------------------------------- |
| 15.4.1  | Manage environment variables           | Positive | Admin → Env Vars → Add/edit/delete vars            | Variables managed at workspace level  |
| 15.4.2  | Configure guardrail policies           | Positive | Admin → Guardrails → Add/edit policies             | Guardrails available to all projects  |
| 15.4.3  | Configure voice services               | Positive | Admin → Voice → Add service → Configure → Save     | Voice service available               |
| 15.4.4  | View workspace billing                 | Positive | Admin → Billing                                    | Usage stats and billing information   |
| 15.4.5  | Manage workspace secrets               | Positive | Admin → Secrets → Add/rotate/delete                | Secrets managed                       |
| 15.4.6  | Configure KMS (BYOK)                   | Positive | Admin → KMS → Configure provider → Save            | Custom encryption keys configured     |
| 15.4.7  | Configure Arch AI settings             | Positive | Admin → Arch → Enable/disable, set model → Save    | Arch AI workspace settings updated    |
| 15.4.8  | Manage connectors                      | Positive | Admin → Connectors → Add/configure → Save          | Workspace connectors configured       |
| 15.4.9  | Update workspace name/slug             | Positive | Admin → Workspace Settings → Edit name → Save      | Workspace name updated                |
| 15.4.10 | Workspace danger zone (delete)         | Edge     | Workspace Settings → Delete → Type name to confirm | Workspace deleted (irreversible)      |
| 15.4.11 | Manage auth profiles (workspace level) | Positive | Admin → Auth Profiles → Add/edit/revoke            | Workspace-level auth profiles managed |

---

## 16. Project Settings

| #     | Scenario                             | Type     | Steps                                                      | Expected Result                           |
| ----- | ------------------------------------ | -------- | ---------------------------------------------------------- | ----------------------------------------- |
| 16.1  | Manage project members               | Positive | Settings → Members → Add/remove/change roles               | Project team managed                      |
| 16.2  | Generate project API keys            | Positive | Settings → API Keys → Generate                             | New key created, shown once               |
| 16.3  | Revoke project API key               | Positive | API Keys → Select → Revoke                                 | Key invalidated                           |
| 16.4  | Configure project models             | Positive | Settings → Models → Select default model, reasoning → Save | Model config saved                        |
| 16.5  | Configure runtime settings           | Positive | Settings → Runtime Config → Edit → Save                    | Runtime behavior updated                  |
| 16.6  | Manage config variables              | Positive | Settings → Config Variables → Add/edit/delete → Save       | Variables available to agents             |
| 16.7  | Configure git integration            | Positive | Settings → Git → Connect repo → Configure branch → Save    | Git integration established               |
| 16.8  | Git pull/push/status                 | Positive | Git integration → Pull/Push/Status                         | Git operations succeed                    |
| 16.9  | Configure PII protection patterns    | Positive | Settings → PII → Add pattern → Name, regex, action → Save  | PII pattern active                        |
| 16.10 | Configure PII with invalid regex     | Negative | Enter malformed regex → Save                               | Validation error: "Invalid regex pattern" |
| 16.11 | Configure trace dimensions           | Positive | Settings → Trace Dimensions → Add/edit → Save              | Custom trace dimensions configured        |
| 16.12 | Configure agent transfer settings    | Positive | Settings → Agent Transfer → Enable/configure → Save        | Transfer settings saved                   |
| 16.13 | Configure attachment settings        | Positive | Settings → Attachments → Set limits, allowed types → Save  | File handling rules configured            |
| 16.14 | Configure omnichannel settings       | Positive | Settings → Omnichannel → Configure channels → Save         | Multi-channel settings saved              |
| 16.15 | Advanced settings                    | Positive | Settings → Advanced → Configure → Save                     | Advanced project options saved            |
| 16.16 | Manage auth profiles (project level) | Positive | Settings → Auth Profiles → Add → OAuth flow → Save         | Project auth profiles configured          |
| 16.17 | Auth profile OAuth flow              | Positive | Add profile → Select provider → Complete OAuth → Save      | OAuth tokens stored                       |
| 16.18 | Auth profile revoke                  | Positive | Auth profile → Revoke                                      | Profile revoked, consumers notified       |
| 16.19 | Batch consent for auth profiles      | Edge     | Multiple profiles need consent → Batch consent gate        | All profiles consented in batch           |

---

## 17. Analytics & Insights

### 17.1 Project Analytics

| #      | Scenario                       | Type     | Steps                                       | Expected Result                                  |
| ------ | ------------------------------ | -------- | ------------------------------------------- | ------------------------------------------------ |
| 17.1.1 | View overview dashboard        | Positive | Insights → Dashboard                        | KPI cards, charts, cost breakdown load           |
| 17.1.2 | View agent performance         | Positive | Insights → Agent Performance                | Per-agent metrics, response times, success rates |
| 17.1.3 | View quality monitor           | Positive | Insights → Quality Monitor                  | Quality scores, trends, alerts                   |
| 17.1.4 | View customer insights         | Positive | Insights → Customer Insights                | User behavior, satisfaction metrics              |
| 17.1.5 | View voice analytics           | Positive | Insights → Voice Analytics                  | Network quality, speech quality, latency charts  |
| 17.1.6 | Filter analytics by date range | Positive | Select date range (30m, 1h, 24h, 7d, 30d)   | Charts update to selected range                  |
| 17.1.7 | Empty analytics (new project)  | Edge     | View analytics for project with no sessions | Empty states with "No data yet" messages         |

### 17.2 Admin Analytics

| #      | Scenario                          | Type     | Steps                                         | Expected Result                  |
| ------ | --------------------------------- | -------- | --------------------------------------------- | -------------------------------- |
| 17.2.1 | Workspace-level agent performance | Positive | Admin → Analytics → Agents                    | Cross-project agent performance  |
| 17.2.2 | Session explorer                  | Positive | Admin → Analytics → Sessions                  | Searchable session explorer      |
| 17.2.3 | Trace viewer                      | Positive | Admin → Analytics → Traces                    | Distributed trace visualization  |
| 17.2.4 | Feature-gated analytics           | Edge     | Non-advanced tenant → Try to access analytics | Feature gate: "Upgrade required" |

### 17.3 Observatory (Debug)

| #      | Scenario               | Type     | Steps                   | Expected Result                          |
| ------ | ---------------------- | -------- | ----------------------- | ---------------------------------------- |
| 17.3.1 | View execution spans   | Positive | Session → Debug → Spans | Hierarchical span tree                   |
| 17.3.2 | View waterfall timing  | Positive | Debug → Waterfall tab   | Timing waterfall of all operations       |
| 17.3.3 | Inspect LLM calls      | Positive | Debug → LLM Calls       | Request/response, token counts, latency  |
| 17.3.4 | View gather progress   | Positive | Debug → Gather          | Field collection progress                |
| 17.3.5 | View memory diffs      | Positive | Debug → Memory          | Memory state changes between turns       |
| 17.3.6 | View decision cards    | Positive | Debug → Decisions       | Agent decision points with reasoning     |
| 17.3.7 | View guardrail results | Positive | Debug → Guardrails      | Guardrail evaluation results per message |
| 17.3.8 | Swim-lane timeline     | Positive | Debug → Interactions    | Multi-agent swim-lane timeline           |

---

## 18. Arch AI Assistant

### 18.1 Arch AI Chat Interface

| #       | Scenario                        | Type     | Steps                                             | Expected Result                                  |
| ------- | ------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------ |
| 18.1.1  | Start new Arch AI session       | Positive | Navigate to `/arch` or click Arch icon            | Chat interface loads with welcome message        |
| 18.1.2  | Describe project to Arch        | Positive | "Build me a customer support bot with FAQ lookup" | Arch asks clarifying questions                   |
| 18.1.3  | Arch interview phase            | Positive | Answer Arch's clarifying questions                | Arch builds understanding, moves to blueprint    |
| 18.1.4  | View architecture blueprint     | Positive | Complete interview → Blueprint phase              | Topology graph showing agent network             |
| 18.1.5  | View spec document              | Positive | Spec Document panel → Open                        | Architecture spec with sections                  |
| 18.1.6  | Build phase (code generation)   | Positive | Approve blueprint → Build                         | Build progress cards show generation status      |
| 18.1.7  | Create project from Arch output | Positive | Build complete → "Create Project"                 | Real project created with generated agents/tools |
| 18.1.8  | Upload context files            | Positive | Upload PDF/DOCX/TXT during interview              | Arch incorporates file content                   |
| 18.1.9  | Session checkpoint and rollback | Edge     | Create checkpoint → Make changes → Rollback       | Session restored to checkpoint state             |
| 18.1.10 | View session journal            | Positive | Journal panel → Open                              | Chronological record of decisions                |
| 18.1.11 | Configure Arch memory/learning  | Positive | Memory Settings → Enable → Configure              | Arch learns from interactions                    |

### 18.2 In-Project Arch AI

| #      | Scenario                     | Type     | Steps                                 | Expected Result                          |
| ------ | ---------------------------- | -------- | ------------------------------------- | ---------------------------------------- |
| 18.2.1 | Open Arch overlay in project | Positive | Project → Click Arch icon             | Overlay panel opens over project content |
| 18.2.2 | Ask Arch about project       | Positive | "What agents are in this project?"    | Arch provides context-aware answer       |
| 18.2.3 | Ask Arch to modify agent     | Positive | "Add a tool to the support agent"     | Arch shows diff, applies on confirmation |
| 18.2.4 | Widget-based interactions    | Positive | Arch shows confirmation/select widget | User interacts with structured widgets   |
| 18.2.5 | Token budget gauge           | Edge     | Long conversation → Monitor budget    | Token usage gauge shows consumption      |

---

## 19. Voice & Softphone

| #    | Scenario                        | Type     | Steps                                             | Expected Result                               |
| ---- | ------------------------------- | -------- | ------------------------------------------------- | --------------------------------------------- |
| 19.1 | Open softphone                  | Positive | Click phone icon in header                        | Softphone popover opens with dial pad         |
| 19.2 | Make voice call                 | Positive | Dial number → Click call                          | Call initiated via Twilio, agent responds     |
| 19.3 | Call controls (mute, hold, end) | Positive | During call → Use controls                        | Mute/hold/end functions work                  |
| 19.4 | TTS preview                     | Positive | Voice settings → TTS Preview → Enter text → Play  | Audio preview of TTS output                   |
| 19.5 | LiveKit voice preview           | Positive | Navigate to `/preview-livekit`                    | LiveKit-based voice streaming works           |
| 19.6 | Voice capabilities check        | Edge     | No voice services configured → Check capabilities | "No voice services available"                 |
| 19.7 | Voice call with poor network    | Edge     | Simulate degraded network → Make call             | Quality degrades gracefully, metrics captured |

---

## 20. Cross-Cutting Concerns

### 20.1 Navigation & UX

| #       | Scenario                          | Type     | Steps                                             | Expected Result                                   |
| ------- | --------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------- |
| 20.1.1  | Command palette (Cmd+K)           | Positive | Press Cmd+K → Type search → Select result         | Navigates to selected item                        |
| 20.1.2  | Universal search                  | Positive | Click search → Enter query                        | Results across agents, tools, workflows, sessions |
| 20.1.3  | Theme toggle (light/dark)         | Positive | Click theme toggle                                | UI switches between light/dark mode               |
| 20.1.4  | Sidebar navigation (all sections) | Positive | Click each sidebar item                           | Correct page loads for each                       |
| 20.1.5  | Sidebar drill-down groups         | Positive | Click group label (OPERATE, INSIGHTS, etc.)       | Group expands/collapses                           |
| 20.1.6  | Breadcrumb navigation             | Positive | Navigate deep → Click breadcrumb                  | Returns to correct parent page                    |
| 20.1.7  | Browser back/forward              | Edge     | Navigate through pages → Use browser back         | Navigation history preserved correctly            |
| 20.1.8  | Deep link to specific page        | Edge     | Paste URL for `/projects/abc/agents/myAgent/chat` | Correct page loads (after auth)                   |
| 20.1.9  | 404 for invalid routes            | Edge     | Navigate to `/projects/nonexistent/agents`        | 404 or redirect, not blank page                   |
| 20.1.10 | Responsive layout                 | Edge     | Resize browser to different widths                | Layout adapts, no broken UI                       |

### 20.2 Workspace Switching

| #      | Scenario                        | Type     | Steps                                 | Expected Result                     |
| ------ | ------------------------------- | -------- | ------------------------------------- | ----------------------------------- |
| 20.2.1 | Switch workspace                | Positive | User menu → Switch Workspace → Select | Context switches to new workspace   |
| 20.2.2 | Switch workspace preserves auth | Edge     | Switch workspace → Verify             | New tenant context, token refreshed |
| 20.2.3 | Workspace with no projects      | Edge     | Switch to empty workspace             | Empty dashboard with create prompt  |

### 20.3 Error Handling

| #      | Scenario                         | Type | Steps                               | Expected Result                                        |
| ------ | -------------------------------- | ---- | ----------------------------------- | ------------------------------------------------------ |
| 20.3.1 | Network disconnection            | Edge | Disconnect network → Attempt action | Clear error message, retry mechanism                   |
| 20.3.2 | Server 500 error                 | Edge | Trigger server error                | User-friendly error message, not raw stack trace       |
| 20.3.3 | Session expired during work      | Edge | Token expires during active use     | Graceful redirect to login, work preserved if possible |
| 20.3.4 | Rate limit exceeded              | Edge | Rapid-fire API calls                | 429 response with "Please wait" message                |
| 20.3.5 | Concurrent modification conflict | Edge | Two users edit same resource        | Conflict detected, merge or last-write-wins            |

### 20.4 Permissions & Access Control

| #      | Scenario                             | Type     | Steps                                                        | Expected Result                               |
| ------ | ------------------------------------ | -------- | ------------------------------------------------------------ | --------------------------------------------- |
| 20.4.1 | Viewer cannot edit agents            | Negative | Login as Viewer role → Try to edit agent                     | Edit button disabled or hidden                |
| 20.4.2 | Non-admin cannot access admin pages  | Negative | Non-admin → Navigate to `/admin`                             | Access denied or redirect                     |
| 20.4.3 | Project member access only           | Negative | User not in project → Access project URL                     | 404 (not 403)                                 |
| 20.4.4 | Feature gate hides locked features   | Edge     | Tenant without `advanced_analytics` → View sidebar           | Analytics items hidden or show upgrade prompt |
| 20.4.5 | Super-admin sees platform admin link | Positive | Login as super-admin → Check header                          | "Platform Admin" link visible                 |
| 20.4.6 | API key scope enforcement            | Edge     | Use API key with limited scope → Attempt out-of-scope action | 403 with scope violation message              |

### 20.5 Data Isolation

| #      | Scenario                              | Type     | Steps                                                | Expected Result             |
| ------ | ------------------------------------- | -------- | ---------------------------------------------------- | --------------------------- |
| 20.5.1 | Cross-tenant data invisible           | Negative | Login as Tenant A → Try to access Tenant B resources | 404 (never 403)             |
| 20.5.2 | Cross-project data invisible          | Negative | Access Project A resource from Project B context     | 404                         |
| 20.5.3 | User cannot see other users' API keys | Negative | View API keys → Only own keys visible                | Other users' keys not shown |

### 20.6 Pipelines (Data/Analytics)

| #      | Scenario                   | Type     | Steps                                       | Expected Result                      |
| ------ | -------------------------- | -------- | ------------------------------------------- | ------------------------------------ |
| 20.6.1 | View pipeline list         | Positive | Insights → Pipelines                        | Built-in and custom pipelines listed |
| 20.6.2 | Create custom pipeline     | Positive | Pipelines → Create → Configure nodes → Save | Pipeline created                     |
| 20.6.3 | Clone existing pipeline    | Positive | Pipeline → Clone                            | Copy created                         |
| 20.6.4 | Edit pipeline graph        | Positive | Open pipeline → Add/connect nodes → Save    | Pipeline graph updated               |
| 20.6.5 | Configure pipeline trigger | Positive | Pipeline → Triggers → Add → Configure       | Trigger activated                    |
| 20.6.6 | Run pipeline manually      | Positive | Pipeline → Run → Monitor progress           | Pipeline executes, results shown     |

### 20.7 Git Integration

| #      | Scenario                     | Type     | Steps                                                | Expected Result                       |
| ------ | ---------------------------- | -------- | ---------------------------------------------------- | ------------------------------------- |
| 20.7.1 | Connect Git repository       | Positive | Settings → Git → Connect → Auth → Select repo → Save | Git integration active                |
| 20.7.2 | View Git status              | Positive | Git → Status                                         | Modified/added/deleted files shown    |
| 20.7.3 | Git pull changes             | Positive | Git → Pull                                           | Remote changes pulled, agents updated |
| 20.7.4 | Git push changes             | Positive | Git → Push                                           | Local changes pushed to remote        |
| 20.7.5 | View Git history             | Positive | Git → History                                        | Commit log shown                      |
| 20.7.6 | Git promote between branches | Positive | Git → Promote → Select target branch                 | Changes promoted                      |
| 20.7.7 | Git conflict on pull         | Edge     | Pull with conflicting changes                        | Conflict resolution UI                |

### 20.8 Alerts

| #      | Scenario                 | Type     | Steps                       | Expected Result                    |
| ------ | ------------------------ | -------- | --------------------------- | ---------------------------------- |
| 20.8.1 | View alerts list         | Positive | Navigate to Alerts page     | Active and historical alerts shown |
| 20.8.2 | Alert triggered by event | Edge     | System event triggers alert | Alert appears with details         |
| 20.8.3 | Acknowledge alert        | Positive | Click alert → Acknowledge   | Alert marked as acknowledged       |
| 20.8.4 | No alerts                | Edge     | No active alerts            | Empty state message                |

### 20.9 Transfer Sessions

| #      | Scenario                    | Type     | Steps                                 | Expected Result                    |
| ------ | --------------------------- | -------- | ------------------------------------- | ---------------------------------- |
| 20.9.1 | View transfer sessions      | Positive | Navigate to Transfer Sessions page    | List of active/completed transfers |
| 20.9.2 | View transfer detail        | Positive | Click transfer session                | Modal with full transfer context   |
| 20.9.3 | End transfer session        | Positive | Transfer → End → Confirm              | Transfer terminated                |
| 20.9.4 | Configure transfer settings | Positive | Settings → Agent Transfer → Configure | Transfer behavior customized       |

### 20.10 Templates

| #       | Scenario                     | Type     | Steps                                 | Expected Result                     |
| ------- | ---------------------------- | -------- | ------------------------------------- | ----------------------------------- |
| 20.10.1 | Browse template catalog      | Positive | Navigate to Templates page            | Template cards with categories      |
| 20.10.2 | Preview template             | Positive | Click template → Preview              | Template details, DSL, JSON shown   |
| 20.10.3 | Insert template into project | Positive | Template → Insert → Configure → Apply | Template resources added to project |

---

## Summary Statistics

| Category                       | Positive | Negative | Edge   | Total   |
| ------------------------------ | -------- | -------- | ------ | ------- |
| 1. Authentication & Login      | 16       | 10       | 10     | 36      |
| 2. Onboarding & Workspace      | 4        | 2        | 2      | 8       |
| 3. Project Management          | 8        | 3        | 5      | 16      |
| 4. Agent Management            | 22       | 5        | 10     | 37      |
| 5. Tool Management             | 17       | 7        | 6      | 30      |
| 6. Workflow Management         | 27       | 3        | 8      | 38      |
| 7. Knowledge Base / Search AI  | 14       | 2        | 3      | 19      |
| 8. Connections & Integrations  | 5        | 1        | 4      | 10      |
| 9. Deployments & Channels      | 10       | 0        | 1      | 11      |
| 10. Sessions & Chat            | 6        | 1        | 4      | 11      |
| 11. Evaluations                | 10       | 1        | 3      | 14      |
| 12. MCP Servers                | 5        | 1        | 2      | 8       |
| 13. Modules                    | 6        | 0        | 3      | 9       |
| 14. Human-in-the-Loop / Inbox  | 7        | 0        | 4      | 11      |
| 15. Admin / Workspace Settings | 19       | 2        | 3      | 24      |
| 16. Project Settings           | 14       | 1        | 4      | 19      |
| 17. Analytics & Insights       | 12       | 0        | 3      | 15      |
| 18. Arch AI                    | 8        | 0        | 3      | 11      |
| 19. Voice & Softphone          | 3        | 0        | 4      | 7       |
| 20. Cross-Cutting              | 22       | 5        | 14     | 41      |
| **TOTAL**                      | **255**  | **44**   | **96** | **395** |

---

## Test Environment

- Runtime: localhost:3112
- Studio: localhost:5173
- MongoDB: localhost:27017/abl_platform (check `.env` for actual port)
- Redis: localhost:6379

---

## Pending / Future Work

- [ ] Performance testing (concurrent users, large data sets)
- [ ] Accessibility testing (screen readers, keyboard navigation)
- [ ] Mobile/responsive testing
- [ ] Internationalization testing (i18n strings)
- [ ] Cross-browser testing (Chrome, Firefox, Safari, Edge)
- [ ] Load testing for WebSocket connections
- [ ] Offline/PWA behavior testing
- [ ] Data migration testing (version upgrades)
